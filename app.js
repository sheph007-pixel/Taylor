// ============================================================
// Route Runner - Delivery Route Planner (Fully Client-Side)
// ============================================================

let state = {
  stops: [],           // Raw stops from upload
  geocodedStops: [],   // Stops with lat/lng
  optimizedStops: [],  // Stops in optimized order
  routeData: null,     // Full route data
  currentStopIndex: 0, // Current stop being navigated to
  deliveredCount: 0,
  skippedCount: 0,
  userLocation: null,
  isPaused: false,
  watchId: null,
  routeName: ''        // Name of current route
};

// Maps
let routeMap = null;
let navMap = null;
let navRouteLayer = null;
let userMarker = null;

// ============================================================
// SCREEN MANAGEMENT
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + id).classList.add('active');

  if (id === 'route' && !routeMap) {
    setTimeout(() => initRouteMap(), 100);
  }
  if (id === 'nav') {
    setTimeout(() => initNavMap(), 100);
  }
}

function showLoading(msg) {
  document.getElementById('loading-message').textContent = msg || 'Loading...';
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

// ============================================================
// FILE UPLOAD & PARSING (All in browser)
// ============================================================
const uploadBox = document.getElementById('upload-box');
const fileInput = document.getElementById('file-input');
const uploadStatus = document.getElementById('upload-status');

uploadBox.addEventListener('click', () => fileInput.click());

uploadBox.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadBox.classList.add('dragover');
});
uploadBox.addEventListener('dragleave', () => uploadBox.classList.remove('dragover'));
uploadBox.addEventListener('drop', (e) => {
  e.preventDefault();
  uploadBox.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

fileInput.addEventListener('change', () => {
  if (fileInput.files.length) handleFile(fileInput.files[0]);
});

async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    showStatus('Please upload a CSV or Excel file.', 'error');
    return;
  }

  showLoading('Reading your delivery list...');

  try {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!rows || rows.length === 0) {
      hideLoading();
      showStatus('File appears empty. Please check your file.', 'error');
      return;
    }

    // Parse rows into stops
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
        let city = '', st = '', zip = '';
        for (const key of keys) {
          const k = key.toLowerCase().trim();
          if (k.includes('city')) city = String(row[key]).trim();
          if (k.includes('state')) st = String(row[key]).trim();
          if (k.includes('zip') || k.includes('postal')) zip = String(row[key]).trim();
          if (k.includes('street') || k.includes('addr')) address = String(row[key]).trim();
        }
        if (!address) address = name;
        if (city) address += ', ' + city;
        if (st) address += ', ' + st;
        if (zip) address += ' ' + zip;
      }

      if (name && address) {
        const addrLower = address.toLowerCase();
        if (!addrLower.includes('alabama') && !addrLower.includes(', al')) {
          address += ', Alabama';
        }
        stops.push({ name, address, delivered: false });
      }
    }

    if (stops.length === 0) {
      hideLoading();
      showStatus('No valid stops found. Make sure your file has columns for company name and address.', 'error');
      return;
    }

    state.stops = stops;
    showStatus('Found ' + stops.length + ' stops', 'success');

    // Now geocode
    document.getElementById('loading-message').textContent = 'Finding addresses on map...';
    await geocodeStops();
    hideLoading();

    if (state.geocodedStops.length > 0) {
      renderStopsList();
      promptRouteName();
    }
  } catch (err) {
    hideLoading();
    showStatus('Failed to read file. Please check the format.', 'error');
    console.error(err);
  }
}

function showStatus(msg, type) {
  uploadStatus.textContent = msg;
  uploadStatus.className = 'upload-status ' + type;
  uploadStatus.classList.remove('hidden');
}

// ============================================================
// GEOCODING (Direct browser calls to Nominatim)
// ============================================================
async function geocodeAddress(address) {
  const query = encodeURIComponent(address);
  const url = 'https://nominatim.openstreetmap.org/search?format=json&q=' + query + '&limit=1&countrycodes=us';

  const res = await fetch(url, {
    headers: { 'User-Agent': 'RouteRunnerApp/1.0' }
  });
  const results = await res.json();

  if (results.length > 0) {
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  }
  throw new Error('Could not find: ' + address);
}

async function geocodeStops() {
  const geocoded = [];
  const errors = [];

  for (let i = 0; i < state.stops.length; i++) {
    document.getElementById('loading-message').textContent =
      'Finding address ' + (i + 1) + ' of ' + state.stops.length + '...';

    try {
      // Nominatim rate limit: 1 request/second
      if (i > 0) await sleep(1100);
      const coords = await geocodeAddress(state.stops[i].address);
      geocoded.push({ ...state.stops[i], ...coords });
    } catch (err) {
      errors.push({ index: i, name: state.stops[i].name, address: state.stops[i].address });
    }
  }

  state.geocodedStops = geocoded;

  if (errors.length > 0) {
    const errNames = errors.map(e => e.name).join(', ');
    showStatus('Could not find: ' + errNames + '. ' + geocoded.length + ' stops ready.', 'error');
  }

  if (geocoded.length === 0) {
    showStatus('No addresses could be found on the map. Please check your file.', 'error');
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================================
// REVIEW STOPS
// ============================================================
function renderStopsList() {
  const list = document.getElementById('stops-list');
  document.getElementById('stop-count').textContent = state.geocodedStops.length + ' stops';

  list.innerHTML = state.geocodedStops.map((stop, i) => `
    <div class="stop-card" data-index="${i}">
      <div class="stop-num">${i + 1}</div>
      <div class="stop-info">
        <div class="stop-name">${escapeHtml(stop.name)}</div>
        <div class="stop-addr">${escapeHtml(stop.address)}</div>
      </div>
      <button class="stop-remove" onclick="removeStop(${i})" aria-label="Remove stop">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  `).join('');
}

function removeStop(index) {
  state.geocodedStops.splice(index, 1);
  renderStopsList();
  if (state.geocodedStops.length === 0) showScreen('upload');
}

function goToUpload() {
  state.stops = [];
  state.geocodedStops = [];
  fileInput.value = '';
  uploadStatus.classList.add('hidden');
  renderSavedRoutes();
  showScreen('upload');
}

function goToReview() {
  showScreen('review');
}

// ============================================================
// ROUTE OPTIMIZATION (Direct browser calls to OSRM)
// ============================================================
async function optimizeRoute() {
  const btn = document.getElementById('btn-optimize');
  btn.disabled = true;
  btn.querySelector('.btn-content').textContent = 'Optimizing...';
  btn.querySelector('.btn-loader').classList.remove('hidden');

  // Get user's current location
  try {
    const pos = await getCurrentPosition();
    state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    document.getElementById('start-label').textContent = 'GPS Location Found';
  } catch (e) {
    // Default to Birmingham, AL center
    state.userLocation = { lat: 33.5186, lng: -86.8104 };
    document.getElementById('start-label').textContent = 'Birmingham, AL (default)';
  }

  // Add starting location as first stop
  const stopsWithStart = [
    { name: 'Start', address: 'Current Location', lat: state.userLocation.lat, lng: state.userLocation.lng, isStart: true },
    ...state.geocodedStops
  ];

  try {
    // Call OSRM trip endpoint for optimal route
    const coords = stopsWithStart.map(s => s.lng + ',' + s.lat).join(';');
    const url = 'https://router.project-osrm.org/trip/v1/driving/' + coords +
      '?overview=full&geometries=geojson&steps=true&annotations=true&source=first&roundtrip=false';

    let result;
    try {
      const res = await fetch(url);
      result = await res.json();
    } catch (e) {
      result = { code: 'Error' };
    }

    let routeData;

    if (result.code === 'Ok') {
      // Reorder stops based on OSRM's optimal waypoint order
      const waypoints = result.waypoints;
      const orderedStops = new Array(stopsWithStart.length);
      for (let i = 0; i < waypoints.length; i++) {
        orderedStops[waypoints[i].waypoint_index] = stopsWithStart[i];
      }

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

      routeData = {
        stops: orderedStops,
        geometry: result.trips[0].geometry,
        totalDistance: result.trips[0].distance,
        totalDuration: result.trips[0].duration,
        directions
      };
    } else {
      // Fallback: use simple route in upload order
      routeData = await getSimpleRoute(stopsWithStart);
    }

    state.routeData = routeData;
    state.optimizedStops = routeData.stops;
    state.currentStopIndex = 1; // Skip start point
    state.deliveredCount = 0;
    state.skippedCount = 0;

    renderRouteOverview();
    document.getElementById('route-title').textContent = state.routeName || 'Your Route';
    showScreen('route');
  } catch (err) {
    alert('Failed to calculate route. Please try again.');
    console.error(err);
  }

  resetOptimizeBtn();
}

async function getSimpleRoute(stops) {
  const coords = stops.map(s => s.lng + ',' + s.lat).join(';');
  const url = 'https://router.project-osrm.org/route/v1/driving/' + coords +
    '?overview=full&geometries=geojson&steps=true';

  const res = await fetch(url);
  const result = await res.json();

  if (result.code !== 'Ok') {
    throw new Error('Could not calculate route');
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

  return {
    stops,
    geometry: route.geometry,
    totalDistance: route.distance,
    totalDuration: route.duration,
    directions
  };
}

function formatInstruction(step) {
  const type = step.maneuver?.type || '';
  const modifier = step.maneuver?.modifier || '';
  const name = step.name || 'the road';

  if (type === 'depart') return 'Head ' + (modifier || 'forward') + ' on ' + name;
  if (type === 'arrive') return 'Arrive at destination';
  if (type === 'turn') return 'Turn ' + modifier + ' onto ' + name;
  if (type === 'merge') return 'Merge ' + modifier + ' onto ' + name;
  if (type === 'fork') return 'Take the ' + modifier + ' fork onto ' + name;
  if (type === 'roundabout') return 'At the roundabout, take exit onto ' + name;
  if (type === 'new name') return 'Continue onto ' + name;
  if (type === 'end of road') return 'Turn ' + modifier + ' onto ' + name;
  if (type === 'continue') return 'Continue ' + modifier + ' on ' + name;
  if (type === 'on ramp' || type === 'off ramp') return 'Take the ramp ' + modifier + ' onto ' + name;
  if (modifier) return modifier.charAt(0).toUpperCase() + modifier.slice(1) + ' onto ' + name;
  return 'Continue on ' + name;
}

function resetOptimizeBtn() {
  const btn = document.getElementById('btn-optimize');
  btn.disabled = false;
  btn.querySelector('.btn-content').textContent = 'Optimize Route';
  btn.querySelector('.btn-loader').classList.add('hidden');
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('No GPS'));
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 8000,
      maximumAge: 30000
    });
  });
}

// ============================================================
// ROUTE OVERVIEW MAP
// ============================================================
function initRouteMap() {
  if (routeMap) {
    routeMap.invalidateSize();
    return;
  }

  routeMap = L.map('route-map', { zoomControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap'
  }).addTo(routeMap);

  displayRouteOnMap(routeMap);
}

function displayRouteOnMap(map) {
  if (!state.routeData) return;

  if (state.routeData.geometry) {
    const coords = state.routeData.geometry.coordinates.map(c => [c[1], c[0]]);
    L.polyline(coords, { color: '#1a73e8', weight: 4, opacity: 0.8 }).addTo(map);
  }

  const bounds = L.latLngBounds();
  state.optimizedStops.forEach((stop, i) => {
    const latlng = [stop.lat, stop.lng];
    bounds.extend(latlng);

    const isStart = stop.isStart;
    const marker = L.marker(latlng, {
      icon: L.divIcon({
        className: '',
        html: '<div class="custom-marker ' + (isStart ? 'start' : '') + '">' + (isStart ? 'S' : i) + '</div>',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      })
    }).addTo(map);

    if (!isStart) {
      marker.bindPopup('<strong>' + escapeHtml(stop.name) + '</strong><br>' + escapeHtml(stop.address));
    }
  });

  map.fitBounds(bounds, { padding: [30, 30] });
}

function renderRouteOverview() {
  const totalMiles = (state.routeData.totalDistance / 1609.34).toFixed(1);
  const totalMins = Math.round(state.routeData.totalDuration / 60);
  document.getElementById('route-stats').textContent = totalMiles + ' mi | ' + totalMins + ' min';

  const list = document.getElementById('route-stops-list');
  const stops = state.optimizedStops;

  list.innerHTML = stops.map((stop, i) => {
    if (stop.isStart) {
      return '<div class="route-stop-card">' +
        '<div class="route-stop-marker"><div class="marker-dot" style="background:#5f6368">S</div><div class="marker-line"></div></div>' +
        '<div class="route-stop-info"><div class="name">Starting Point</div><div class="addr">Your current location</div></div></div>';
    }

    const legInfo = state.routeData.directions && state.routeData.directions[i - 1]
      ? formatDuration(state.routeData.directions[i - 1].duration) + ' | ' +
        formatDistance(state.routeData.directions[i - 1].distance)
      : '';

    return '<div class="route-stop-card">' +
      '<div class="route-stop-marker"><div class="marker-dot">' + i + '</div><div class="marker-line"></div></div>' +
      '<div class="route-stop-info"><div class="name">' + escapeHtml(stop.name) + '</div>' +
      '<div class="addr">' + escapeHtml(stop.address) + '</div>' +
      (legInfo ? '<div class="leg-info">' + legInfo + '</div>' : '') +
      '</div></div>';
  }).join('');
}

// ============================================================
// NAVIGATION
// ============================================================
function startNavigation() {
  showScreen('nav');
  startGPSTracking();
  navigateToCurrentStop();
}

function initNavMap() {
  if (navMap) {
    navMap.invalidateSize();
    return;
  }

  navMap = L.map('nav-map', { zoomControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OSM'
  }).addTo(navMap);
}

async function navigateToCurrentStop() {
  const stop = state.optimizedStops[state.currentStopIndex];
  if (!stop) {
    tripComplete();
    return;
  }

  const stopNum = state.currentStopIndex;
  document.getElementById('nav-stop-number').textContent = stopNum;
  document.getElementById('nav-company').textContent = stop.name;
  document.getElementById('nav-address').textContent = stop.address;

  // Get route segment from OSRM
  const fromStop = state.userLocation || state.optimizedStops[state.currentStopIndex - 1] || state.optimizedStops[0];

  try {
    const coords = fromStop.lng + ',' + fromStop.lat + ';' + stop.lng + ',' + stop.lat;
    const url = 'https://router.project-osrm.org/route/v1/driving/' + coords +
      '?overview=full&geometries=geojson&steps=true';

    const res = await fetch(url);
    const result = await res.json();

    if (result.code === 'Ok') {
      const route = result.routes[0];
      const routeData = {
        geometry: route.geometry,
        distance: route.distance,
        duration: route.duration,
        steps: route.legs[0].steps.map(step => ({
          instruction: formatInstruction(step),
          distance: step.distance,
          duration: step.duration,
          name: step.name || '',
          maneuver: step.maneuver,
          geometry: step.geometry
        }))
      };
      displayNavRoute(routeData, stop);
      displayNavDirections(routeData);
    }
  } catch (err) {
    console.error('Nav route error:', err);
  }
}

function displayNavRoute(routeData, targetStop) {
  if (!navMap) return;

  // Clear previous layers
  if (navRouteLayer) navMap.removeLayer(navRouteLayer);
  navMap.eachLayer(layer => {
    if (layer instanceof L.Marker || layer instanceof L.CircleMarker) {
      navMap.removeLayer(layer);
    }
  });

  // Draw route
  if (routeData.geometry) {
    const coords = routeData.geometry.coordinates.map(c => [c[1], c[0]]);
    navRouteLayer = L.polyline(coords, { color: '#1a73e8', weight: 5, opacity: 0.9 }).addTo(navMap);
  }

  // Destination marker
  L.marker([targetStop.lat, targetStop.lng], {
    icon: L.divIcon({
      className: '',
      html: '<div class="custom-marker current">' + state.currentStopIndex + '</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    })
  }).addTo(navMap).bindPopup('<strong>' + escapeHtml(targetStop.name) + '</strong>');

  // User location marker
  if (state.userLocation) {
    userMarker = L.circleMarker([state.userLocation.lat, state.userLocation.lng], {
      radius: 8, fillColor: '#4285f4', fillOpacity: 1, color: 'white', weight: 2
    }).addTo(navMap);
  }

  // Fit view
  const bounds = L.latLngBounds([[targetStop.lat, targetStop.lng]]);
  if (state.userLocation) bounds.extend([state.userLocation.lat, state.userLocation.lng]);
  navMap.fitBounds(bounds, { padding: [60, 60] });

  // ETA
  const mins = Math.round(routeData.duration / 60);
  document.getElementById('nav-eta').textContent = mins < 1 ? '<1' : mins;
}

function displayNavDirections(routeData) {
  if (!routeData.steps) return;

  const firstStep = routeData.steps[0];
  if (firstStep) {
    document.getElementById('direction-text').textContent = firstStep.instruction;
    document.getElementById('direction-distance').textContent = formatDistance(firstStep.distance);
    updateDirectionIcon(firstStep.maneuver);
  }

  const stepsContainer = document.getElementById('nav-steps');
  stepsContainer.innerHTML = routeData.steps
    .filter(s => s.instruction !== 'Arrive at destination' || routeData.steps.length <= 2)
    .slice(0, 8)
    .map(step =>
      '<div class="nav-step"><span class="step-text">' + step.instruction +
      '</span><span class="step-dist">' + formatDistance(step.distance) + '</span></div>'
    ).join('');
}

function updateDirectionIcon(maneuver) {
  const iconEl = document.getElementById('direction-icon');
  const modifier = maneuver?.modifier || '';

  let svg = '';
  if (modifier.includes('left')) {
    svg = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="15 4 7 4 7 16"/><polyline points="11 8 7 4 3 8"/></svg>';
  } else if (modifier.includes('right')) {
    svg = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="9 4 17 4 17 16"/><polyline points="13 8 17 4 21 8"/></svg>';
  } else {
    svg = '<svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5"><polyline points="12 19 12 5"/><polyline points="5 12 12 5 19 12"/></svg>';
  }
  iconEl.innerHTML = svg;
}

// ============================================================
// GPS TRACKING
// ============================================================
function startGPSTracking() {
  if (state.watchId) navigator.geolocation.clearWatch(state.watchId);

  if (navigator.geolocation) {
    state.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        updateUserMarker();
        checkProximity();
      },
      (err) => console.log('GPS error:', err.message),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  }
}

function stopGPSTracking() {
  if (state.watchId) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
}

function updateUserMarker() {
  if (!navMap || !state.userLocation) return;
  if (userMarker) {
    userMarker.setLatLng([state.userLocation.lat, state.userLocation.lng]);
  } else {
    userMarker = L.circleMarker([state.userLocation.lat, state.userLocation.lng], {
      radius: 8, fillColor: '#4285f4', fillOpacity: 1, color: 'white', weight: 2
    }).addTo(navMap);
  }
}

function checkProximity() {
  const stop = state.optimizedStops[state.currentStopIndex];
  if (!stop || !state.userLocation) return;

  const dist = getDistanceMeters(
    state.userLocation.lat, state.userLocation.lng,
    stop.lat, stop.lng
  );

  if (dist < 100) {
    showArrivedScreen();
  }
}

function getDistanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ============================================================
// DELIVERY ACTIONS
// ============================================================
function showArrivedScreen() {
  const stop = state.optimizedStops[state.currentStopIndex];
  const totalStops = state.optimizedStops.length - 1;

  document.getElementById('arrived-company').textContent = stop.name;
  document.getElementById('arrived-address').textContent = stop.address;
  document.getElementById('arrived-stop-num').textContent = state.currentStopIndex;
  document.getElementById('arrived-total').textContent = totalStops;

  showScreen('arrived');
}

function markDelivered() {
  state.optimizedStops[state.currentStopIndex].delivered = true;
  state.deliveredCount++;
  state.currentStopIndex++;
  saveProgress();
  goToNextStop();
}

function skipStop() {
  state.optimizedStops[state.currentStopIndex].skipped = true;
  state.skippedCount++;
  state.currentStopIndex++;
  saveProgress();
  goToNextStop();
}

function goToNextStop() {
  if (state.currentStopIndex >= state.optimizedStops.length) {
    tripComplete();
    return;
  }
  showScreen('nav');
  navigateToCurrentStop();
}

// ============================================================
// PAUSE / RESUME
// ============================================================
function pauseTrip() {
  state.isPaused = true;
  stopGPSTracking();

  const totalStops = state.optimizedStops.length - 1;
  document.getElementById('paused-done').textContent = state.deliveredCount;
  document.getElementById('paused-total').textContent = totalStops;

  const nextStop = state.optimizedStops[state.currentStopIndex];
  document.getElementById('paused-next-name').textContent = nextStop ? nextStop.name : 'None';

  saveProgress();
  showScreen('paused');
}

function resumeTrip() {
  state.isPaused = false;
  showScreen('nav');
  startGPSTracking();
  navigateToCurrentStop();
}

function endTrip() {
  if (confirm('End trip? Your progress will be saved.')) {
    tripComplete();
  }
}

// ============================================================
// TRIP COMPLETE
// ============================================================
function tripComplete() {
  stopGPSTracking();
  document.getElementById('complete-delivered').textContent = state.deliveredCount;
  document.getElementById('complete-skipped').textContent = state.skippedCount;
  clearProgress();
  showScreen('complete');
}

function newTrip() {
  state = {
    stops: [], geocodedStops: [], optimizedStops: [], routeData: null,
    currentStopIndex: 0, deliveredCount: 0, skippedCount: 0,
    userLocation: null, isPaused: false, watchId: null, routeName: ''
  };
  routeMap = null;
  navMap = null;
  navRouteLayer = null;
  userMarker = null;
  fileInput.value = '';
  uploadStatus.classList.add('hidden');
  document.getElementById('route-map').innerHTML = '';
  document.getElementById('nav-map').innerHTML = '';
  showScreen('upload');
}

// ============================================================
// SHARE ROUTE - Send route to another device
// Uses Web Share API (native share sheet) with fallbacks
// ============================================================
function shareRoute() {
  const url = buildShareUrl();
  const name = state.routeName || 'My Route';

  // Use native Web Share API if available (works on most phones & modern browsers)
  if (navigator.share) {
    navigator.share({
      title: name + ' - Route Runner',
      text: 'Open this link to load the "' + name + '" route:',
      url: url
    }).catch(function() {
      // User cancelled or share failed — fall back to copy
      copyShareLink();
    });
  } else {
    // Desktop browsers without Web Share — copy to clipboard
    copyShareLink();
  }
}

// ============================================================
// SAVED ROUTES - Name, Save, Load, Delete
// ============================================================
function promptRouteName() {
  document.getElementById('route-name-modal').classList.remove('hidden');
  const input = document.getElementById('route-name-input');
  input.value = '';
  input.focus();
}

function saveRouteWithName() {
  const input = document.getElementById('route-name-input');
  const name = input.value.trim();
  if (!name) {
    input.classList.add('input-error');
    setTimeout(() => input.classList.remove('input-error'), 600);
    return;
  }

  state.routeName = name;
  const savedRoutes = getSavedRoutes();

  savedRoutes[name] = {
    stops: state.geocodedStops,
    savedAt: Date.now(),
    stopCount: state.geocodedStops.length
  };

  localStorage.setItem('routerunner_saved_routes', JSON.stringify(savedRoutes));
  renderSavedRoutes();

  // Update browser URL to contain route data — this URL works on any device
  var url = buildShareUrl();
  history.replaceState(null, '', url.replace(window.location.origin, ''));

  // Close modal and go to review
  document.getElementById('route-name-modal').classList.add('hidden');
  showScreen('review');

  // Show the link bar so user can copy/bookmark
  showRouteLink(url);
}

function showShareStep() {
  document.getElementById('modal-step-name').classList.add('hidden');
  document.getElementById('modal-step-share').classList.remove('hidden');
}

function buildShareUrl() {
  const data = {
    n: state.routeName || 'Shared Route',
    s: state.geocodedStops.map(s => ({
      nm: s.name,
      ad: s.address,
      la: Math.round(s.lat * 1e6) / 1e6,
      ln: Math.round(s.lng * 1e6) / 1e6
    }))
  };
  const json = JSON.stringify(data);

  // Use query param ?r= instead of hash — email apps strip # fragments
  if (typeof LZString !== 'undefined') {
    const compressed = LZString.compressToEncodedURIComponent(json);
    return window.location.origin + window.location.pathname + '?r=' + compressed;
  }

  const encoded = btoa(unescape(encodeURIComponent(json)));
  return window.location.origin + window.location.pathname + '?route=' + encoded;
}

function sendToPhone() {
  const url = buildShareUrl();
  // Use email on desktop — works everywhere
  window.location.href = 'mailto:?subject=' + encodeURIComponent('My Route') + '&body=' + encodeURIComponent('Open this link on your phone:\n\n' + url);
}

function copyShareLink() {
  const url = buildShareUrl();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(() => {
      const btn = document.querySelector('.btn-copy-link');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copy Link'; }, 2000);
    }).catch(() => {
      prompt('Copy this link:', url);
    });
  } else {
    prompt('Copy this link:', url);
  }
}

function closeShareModal() {
  document.getElementById('route-name-modal').classList.add('hidden');
  // Reset modal to step 1 for next time
  document.getElementById('modal-step-name').classList.remove('hidden');
  document.getElementById('modal-step-share').classList.add('hidden');
  showScreen('review');
}

function skipRouteName() {
  state.routeName = '';
  document.getElementById('route-name-modal').classList.add('hidden');
  // Reset modal steps
  document.getElementById('modal-step-name').classList.remove('hidden');
  document.getElementById('modal-step-share').classList.add('hidden');
  showScreen('review');
}

// Server routes loaded from routes.json (available on all devices)
var serverRoutes = {};

function loadServerRoutes() {
  return fetch('routes.json?t=' + Date.now())
    .then(function(r) { return r.json(); })
    .then(function(data) {
      serverRoutes = data || {};
      renderSavedRoutes();
    })
    .catch(function() { serverRoutes = {}; });
}

function getSavedRoutes() {
  // Merge server routes (shared across all devices) with local routes
  var local = {};
  try {
    local = JSON.parse(localStorage.getItem('routerunner_saved_routes') || '{}');
  } catch (e) {}
  // Server routes take priority — they're the "real" ones
  var merged = {};
  Object.keys(serverRoutes).forEach(function(k) { merged[k] = serverRoutes[k]; });
  Object.keys(local).forEach(function(k) { if (!merged[k]) merged[k] = local[k]; });
  return merged;
}

function renderSavedRoutes() {
  const routes = getSavedRoutes();
  const keys = Object.keys(routes);
  const section = document.getElementById('saved-routes-section');
  const list = document.getElementById('saved-routes-list');

  if (keys.length === 0) {
    section.classList.add('hidden');
    return;
  }

  section.classList.remove('hidden');

  // Sort by most recently saved
  keys.sort((a, b) => routes[b].savedAt - routes[a].savedAt);

  list.innerHTML = keys.map(name => {
    const route = routes[name];
    const date = new Date(route.savedAt);
    const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return '<div class="saved-route-card">' +
      '<div class="saved-route-info" onclick="loadSavedRoute(\'' + escapeAttr(name) + '\')">' +
        '<div class="saved-route-name">' + escapeHtml(name) + '</div>' +
        '<div class="saved-route-meta">' + route.stopCount + ' stops &middot; ' + dateStr + '</div>' +
      '</div>' +
      '<button class="saved-route-delete" onclick="deleteSavedRoute(\'' + escapeAttr(name) + '\')" aria-label="Delete route">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</button>' +
    '</div>';
  }).join('');
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function loadSavedRoute(name) {
  const routes = getSavedRoutes();
  const route = routes[name];
  if (!route) return;

  state.routeName = name;
  state.geocodedStops = route.stops;
  state.stops = route.stops.map(s => ({ name: s.name, address: s.address, delivered: false }));
  renderStopsList();
  showScreen('review');
}

function showRouteLink(url) {
  // Remove any existing link bar
  var existing = document.getElementById('route-link-bar');
  if (existing) existing.remove();

  var bar = document.createElement('div');
  bar.id = 'route-link-bar';
  bar.className = 'route-link-bar';
  bar.innerHTML = '<p>Open this URL on your phone to use this route:</p>' +
    '<div class="route-link-url">' + url + '</div>' +
    '<button class="btn-primary" onclick="copyRouteLink()">Copy Link</button>';

  // Insert at top of current screen
  var screen = document.querySelector('.screen:not(.hidden)');
  if (screen) screen.insertBefore(bar, screen.firstChild.nextSibling);
}

function copyRouteLink() {
  var urlEl = document.querySelector('.route-link-url');
  if (!urlEl) return;
  var url = urlEl.textContent;
  if (navigator.clipboard) {
    navigator.clipboard.writeText(url).then(function() {
      var btn = document.querySelector('#route-link-bar .btn-primary');
      btn.textContent = 'Copied!';
      setTimeout(function() { btn.textContent = 'Copy Link'; }, 2000);
    });
  } else {
    prompt('Copy this link:', url);
  }
}

function deleteSavedRoute(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  const routes = getSavedRoutes();
  delete routes[name];
  localStorage.setItem('routerunner_saved_routes', JSON.stringify(routes));
  renderSavedRoutes();
}

function shareSavedRoute(name) {
  var url = buildShareUrlForRoute(name);
  if (!url) return;
  // Use email on desktop — works everywhere
  window.location.href = 'mailto:?subject=' + encodeURIComponent(name + ' Route') + '&body=' + encodeURIComponent('Open this link on your phone:\n\n' + url);
}

function buildShareUrlForRoute(name) {
  var routes = getSavedRoutes();
  var route = routes[name];
  if (!route) return null;
  var data = {
    n: name,
    s: route.stops.map(function(s) {
      return { nm: s.name, ad: s.address, la: Math.round(s.lat * 1e6) / 1e6, ln: Math.round(s.lng * 1e6) / 1e6 };
    })
  };
  var json = JSON.stringify(data);
  if (typeof LZString !== 'undefined') {
    return window.location.origin + window.location.pathname + '?r=' + LZString.compressToEncodedURIComponent(json);
  }
  return window.location.origin + window.location.pathname + '?route=' + btoa(unescape(encodeURIComponent(json)));
}

// ============================================================
// LOCAL STORAGE - Save/Restore Progress
// ============================================================
function saveProgress() {
  const data = {
    optimizedStops: state.optimizedStops,
    routeData: state.routeData,
    currentStopIndex: state.currentStopIndex,
    deliveredCount: state.deliveredCount,
    skippedCount: state.skippedCount,
    userLocation: state.userLocation,
    savedAt: Date.now()
  };
  localStorage.setItem('routerunner_progress', JSON.stringify(data));
}

function clearProgress() {
  localStorage.removeItem('routerunner_progress');
}

function checkSavedProgress() {
  const saved = localStorage.getItem('routerunner_progress');
  if (!saved) return;

  try {
    const data = JSON.parse(saved);
    if (Date.now() - data.savedAt > 24 * 60 * 60 * 1000) {
      clearProgress();
      return;
    }

    if (data.optimizedStops && data.currentStopIndex < data.optimizedStops.length) {
      if (confirm('You have a saved trip with ' + (data.optimizedStops.length - 1) + ' stops. Resume where you left off?')) {
        state.optimizedStops = data.optimizedStops;
        state.routeData = data.routeData;
        state.currentStopIndex = data.currentStopIndex;
        state.deliveredCount = data.deliveredCount;
        state.skippedCount = data.skippedCount;
        state.userLocation = data.userLocation;

        const totalStops = state.optimizedStops.length - 1;
        document.getElementById('paused-done').textContent = state.deliveredCount;
        document.getElementById('paused-total').textContent = totalStops;
        const nextStop = state.optimizedStops[state.currentStopIndex];
        document.getElementById('paused-next-name').textContent = nextStop ? nextStop.name : 'None';
        showScreen('paused');
      } else {
        clearProgress();
      }
    }
  } catch (e) {
    clearProgress();
  }
}

// ============================================================
// HELPERS
// ============================================================
function formatDistance(meters) {
  const miles = meters / 1609.34;
  if (miles < 0.1) return Math.round(meters * 3.28084) + ' ft';
  return miles.toFixed(1) + ' mi';
}

function formatDuration(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return mins + ' min';
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return hrs + 'h ' + rem + 'm';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  // Load shared routes from server first, then render
  loadServerRoutes();
  renderSavedRoutes();
  checkSavedProgress();

  // Check if route data is in URL (shared link)
  loadFromShareLink();

  // Enter key in route name input
  document.getElementById('route-name-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveRouteWithName();
  });

});

// ============================================================
// SHARE LINK - Encode route data in URL for cross-device use
// ============================================================
function generateShareLink() {
  if (!state.geocodedStops || state.geocodedStops.length === 0) return;

  // Show the modal with QR code directly (skip naming step)
  document.getElementById('modal-step-name').classList.add('hidden');
  document.getElementById('modal-step-share').classList.remove('hidden');
  document.getElementById('route-name-modal').classList.remove('hidden');
  showShareStep();
}

function loadFromShareLink() {
  // Check query params first (?r=), then fall back to hash (#r=)
  var params = new URLSearchParams(window.location.search);
  var compressed = params.get('r');
  var legacy = params.get('route');
  var hash = window.location.hash;

  try {
    var json;
    if (compressed && typeof LZString !== 'undefined') {
      json = LZString.decompressFromEncodedURIComponent(compressed);
    } else if (legacy) {
      json = decodeURIComponent(escape(atob(legacy)));
    } else if (hash.startsWith('#r=') && typeof LZString !== 'undefined') {
      json = LZString.decompressFromEncodedURIComponent(hash.substring(3));
    } else if (hash.startsWith('#route=')) {
      json = decodeURIComponent(escape(atob(hash.substring(7))));
    } else {
      return;
    }

    const data = JSON.parse(json);
    if (!data.s || data.s.length === 0) return;

    state.routeName = data.n || 'Shared Route';
    state.geocodedStops = data.s.map(s => ({
      name: s.nm,
      address: s.ad,
      lat: s.la,
      lng: s.ln,
      delivered: false
    }));
    state.stops = state.geocodedStops.map(s => ({ name: s.name, address: s.address, delivered: false }));

    // Clean URL
    history.replaceState(null, '', window.location.pathname);

    // Auto-save this shared route
    const savedRoutes = getSavedRoutes();
    if (!savedRoutes[state.routeName]) {
      savedRoutes[state.routeName] = {
        stops: state.geocodedStops,
        savedAt: Date.now(),
        stopCount: state.geocodedStops.length
      };
      localStorage.setItem('routerunner_saved_routes', JSON.stringify(savedRoutes));
      renderSavedRoutes();
    }

    renderStopsList();
    showScreen('review');
  } catch (e) {
    console.error('Failed to load shared route:', e);
  }
}
