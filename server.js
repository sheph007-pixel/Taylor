const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Parse uploaded file (CSV or Excel) into list of stops
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const ext = path.extname(req.file.originalname).toLowerCase();
    let rows = [];

    if (ext === '.csv') {
      const content = req.file.buffer.toString('utf-8');
      rows = parse(content, { columns: true, skip_empty_lines: true, trim: true });
    } else if (ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);
    } else {
      return res.status(400).json({ error: 'Please upload a CSV or Excel file (.csv, .xlsx, .xls)' });
    }

    // Normalize column names - find company/name and address columns
    const stops = [];
    for (const row of rows) {
      const keys = Object.keys(row);
      let name = '';
      let address = '';

      for (const key of keys) {
        const k = key.toLowerCase().trim();
        if (k.includes('company') || k.includes('name') || k.includes('business') || k.includes('customer')) {
          name = String(row[key]).trim();
        }
        if (k.includes('address') || k.includes('location') || k.includes('street') || k.includes('destination')) {
          address = String(row[key]).trim();
        }
      }

      // If no named columns found, use first two columns
      if (!name && !address && keys.length >= 2) {
        name = String(row[keys[0]]).trim();
        address = String(row[keys[1]]).trim();
      } else if (!name && address) {
        name = address;
      } else if (name && !address) {
        // If only name column, check if there are city/state/zip columns to build address
        let city = '', state = '', zip = '';
        for (const key of keys) {
          const k = key.toLowerCase().trim();
          if (k.includes('city')) city = String(row[key]).trim();
          if (k.includes('state')) state = String(row[key]).trim();
          if (k.includes('zip') || k.includes('postal')) zip = String(row[key]).trim();
          if (k.includes('street') || k.includes('addr')) address = String(row[key]).trim();
        }
        if (!address) address = name;
        if (city) address += ', ' + city;
        if (state) address += ', ' + state;
        if (zip) address += ' ' + zip;
      }

      if (name && address) {
        // Ensure Alabama context for geocoding
        const addrLower = address.toLowerCase();
        if (!addrLower.includes('alabama') && !addrLower.includes(', al')) {
          address += ', Alabama';
        }
        stops.push({ name, address, delivered: false });
      }
    }

    if (stops.length === 0) {
      return res.status(400).json({ error: 'No valid stops found. Make sure your file has columns for company name and address.' });
    }

    res.json({ stops, count: stops.length });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Failed to parse file. Please check format.' });
  }
});

// Geocode an address using OpenStreetMap Nominatim
async function geocodeAddress(address) {
  return new Promise((resolve, reject) => {
    const query = encodeURIComponent(address);
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${query}&limit=1&countrycodes=us`;

    https.get(url, { headers: { 'User-Agent': 'DeliveryRoutePlanner/1.0' } }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results.length > 0) {
            resolve({ lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) });
          } else {
            reject(new Error(`Could not find: ${address}`));
          }
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// Geocode all stops
app.post('/api/geocode', async (req, res) => {
  try {
    const { stops } = req.body;
    const geocoded = [];
    const errors = [];

    for (let i = 0; i < stops.length; i++) {
      try {
        // Nominatim rate limit: 1 request/second
        if (i > 0) await new Promise(r => setTimeout(r, 1100));
        const coords = await geocodeAddress(stops[i].address);
        geocoded.push({ ...stops[i], ...coords });
      } catch (err) {
        errors.push({ index: i, name: stops[i].name, address: stops[i].address, error: err.message });
      }
    }

    res.json({ stops: geocoded, errors });
  } catch (err) {
    console.error('Geocode error:', err);
    res.status(500).json({ error: 'Geocoding failed' });
  }
});

// Get route from OSRM (free, no API key)
app.post('/api/route', async (req, res) => {
  try {
    const { stops } = req.body; // Already ordered stops with lat/lng

    if (stops.length < 2) {
      return res.json({ stops, route: null });
    }

    // Use OSRM trip endpoint to get optimal ordering
    const coords = stops.map(s => `${s.lng},${s.lat}`).join(';');
    const url = `https://router.project-osrm.org/trip/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&annotations=true&source=first&roundtrip=false`;

    const data = await fetchUrl(url);
    const result = JSON.parse(data);

    if (result.code !== 'Ok') {
      // Fallback: use simple route instead of trip
      return await getSimpleRoute(stops, res);
    }

    // Reorder stops based on OSRM's optimal waypoint order
    const waypoints = result.waypoints;
    const orderedStops = new Array(stops.length);
    for (let i = 0; i < waypoints.length; i++) {
      orderedStops[waypoints[i].waypoint_index] = stops[i];
    }

    // Extract steps for turn-by-turn
    const legs = result.trips[0].legs;
    const directions = [];
    for (let i = 0; i < legs.length; i++) {
      const legSteps = legs[i].steps.map(step => ({
        instruction: formatInstruction(step),
        distance: step.distance,
        duration: step.duration,
        name: step.name || '',
        maneuver: step.maneuver
      }));
      directions.push({
        toStop: i + 1,
        stopName: orderedStops[i + 1]?.name || '',
        steps: legSteps,
        distance: legs[i].distance,
        duration: legs[i].duration
      });
    }

    res.json({
      stops: orderedStops,
      geometry: result.trips[0].geometry,
      totalDistance: result.trips[0].distance,
      totalDuration: result.trips[0].duration,
      directions
    });
  } catch (err) {
    console.error('Route error:', err);
    res.status(500).json({ error: 'Failed to calculate route' });
  }
});

// Get route between two consecutive stops (for navigation)
app.post('/api/route-segment', async (req, res) => {
  try {
    const { from, to } = req.body;
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;

    const data = await fetchUrl(url);
    const result = JSON.parse(data);

    if (result.code !== 'Ok') {
      return res.status(400).json({ error: 'Could not calculate route segment' });
    }

    const route = result.routes[0];
    const steps = route.legs[0].steps.map(step => ({
      instruction: formatInstruction(step),
      distance: step.distance,
      duration: step.duration,
      name: step.name || '',
      maneuver: step.maneuver,
      geometry: step.geometry
    }));

    res.json({
      geometry: route.geometry,
      distance: route.distance,
      duration: route.duration,
      steps
    });
  } catch (err) {
    console.error('Route segment error:', err);
    res.status(500).json({ error: 'Failed to get directions' });
  }
});

async function getSimpleRoute(stops, res) {
  const coords = stops.map(s => `${s.lng},${s.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true`;

  const data = await fetchUrl(url);
  const result = JSON.parse(data);

  if (result.code !== 'Ok') {
    return res.status(400).json({ error: 'Could not calculate route' });
  }

  const route = result.routes[0];
  const legs = route.legs;
  const directions = [];
  for (let i = 0; i < legs.length; i++) {
    const legSteps = legs[i].steps.map(step => ({
      instruction: formatInstruction(step),
      distance: step.distance,
      duration: step.duration,
      name: step.name || '',
      maneuver: step.maneuver
    }));
    directions.push({
      toStop: i + 1,
      stopName: stops[i + 1]?.name || '',
      steps: legSteps,
      distance: legs[i].distance,
      duration: legs[i].duration
    });
  }

  res.json({
    stops,
    geometry: route.geometry,
    totalDistance: route.distance,
    totalDuration: route.duration,
    directions
  });
}

function formatInstruction(step) {
  const type = step.maneuver?.type || '';
  const modifier = step.maneuver?.modifier || '';
  const name = step.name || 'the road';

  if (type === 'depart') return `Head ${modifier || 'forward'} on ${name}`;
  if (type === 'arrive') return `Arrive at destination`;
  if (type === 'turn') return `Turn ${modifier} onto ${name}`;
  if (type === 'merge') return `Merge ${modifier} onto ${name}`;
  if (type === 'fork') return `Take the ${modifier} fork onto ${name}`;
  if (type === 'roundabout') return `At the roundabout, take exit onto ${name}`;
  if (type === 'new name') return `Continue onto ${name}`;
  if (type === 'end of road') return `Turn ${modifier} onto ${name}`;
  if (type === 'continue') return `Continue ${modifier} on ${name}`;
  if (type === 'on ramp' || type === 'off ramp') return `Take the ramp ${modifier} onto ${name}`;
  if (modifier) return `${modifier.charAt(0).toUpperCase() + modifier.slice(1)} onto ${name}`;
  return `Continue on ${name}`;
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'DeliveryRoutePlanner/1.0' } }, (response) => {
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Save a named route to routes.json and push to GitHub so it's available on all devices
const ROUTES_FILE = path.join(__dirname, 'routes.json');

app.post('/api/save-route', (req, res) => {
  try {
    const { name, stops, estimate } = req.body;
    if (!name || !stops || stops.length === 0) {
      return res.status(400).json({ error: 'Name and stops required' });
    }

    // Load existing routes
    let routes = {};
    try {
      routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf-8'));
    } catch (e) {}

    // Save the route
    routes[name] = {
      stops: stops,
      savedAt: Date.now(),
      stopCount: stops.length,
      estimate: estimate || null
    };

    fs.writeFileSync(ROUTES_FILE, JSON.stringify(routes, null, 2));

    // Auto-push to GitHub so the site updates
    try {
      execSync('git add routes.json && git commit -m "Add route: ' + name.replace(/"/g, '\\"') + '" && git push', {
        cwd: __dirname,
        stdio: 'pipe'
      });
      console.log('Route "' + name + '" saved and pushed to GitHub');
    } catch (gitErr) {
      console.log('Route saved locally (git push skipped):', gitErr.message);
    }

    res.json({ success: true, message: 'Route saved' });
  } catch (err) {
    console.error('Save route error:', err);
    res.status(500).json({ error: 'Failed to save route' });
  }
});

// Delete a route
app.post('/api/delete-route', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Name required' });

    let routes = {};
    try { routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf-8')); } catch (e) {}

    delete routes[name];
    fs.writeFileSync(ROUTES_FILE, JSON.stringify(routes, null, 2));

    try {
      execSync('git add routes.json && git commit -m "Delete route: ' + name.replace(/"/g, '\\"') + '" && git push', {
        cwd: __dirname, stdio: 'pipe'
      });
    } catch (gitErr) {
      console.log('Route deleted locally (git push skipped):', gitErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete route error:', err);
    res.status(500).json({ error: 'Failed to delete route' });
  }
});

// Serve routes.json
app.get('/api/routes', (req, res) => {
  try {
    const routes = JSON.parse(fs.readFileSync(ROUTES_FILE, 'utf-8'));
    res.json(routes);
  } catch (e) {
    res.json({});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Delivery Route Planner running on http://localhost:${PORT}`);
});
