// ============================================================
// Route Runner — Admin
// ============================================================

// Shared state
const CODE_VERSION = 10;
let geocodedStops = [];
let routeEstimate = null;
let cachedAdminRoutes = {};

// ============================================================
// Screen / tab management
// ============================================================
function showAdminScreen(id) {
  document.querySelectorAll('.admin-screen').forEach(function(s) {
    s.classList.toggle('active', s.id === 'admin-screen-' + id);
  });
  document.querySelectorAll('.rr-admin-tab').forEach(function(t) {
    var target = t.getAttribute('data-tab');
    // The edit screen keeps "routes" tab highlighted since it's a sub-view
    var activeTab = id === 'edit' ? 'routes' : id;
    t.classList.toggle('is-active', target === activeTab);
  });
  if (id === 'routes') {
    // lazy refresh if data came in after initial load
    renderSavedRoutesAdmin(cachedAdminRoutes);
  }
}

// ============================================================
// Geocode cache
// ============================================================
const geocodeCache = {};
try {
  const savedVersion = parseInt(localStorage.getItem('rr_cache_version') || '0');
  if (savedVersion < CODE_VERSION) {
    localStorage.removeItem('rr_geocache');
    localStorage.setItem('rr_cache_version', String(CODE_VERSION));
  } else {
    const cached = JSON.parse(localStorage.getItem('rr_geocache') || '{}');
    Object.assign(geocodeCache, cached);
  }
} catch (e) {
  localStorage.removeItem('rr_geocache');
}

function saveGeoCache() {
  try { localStorage.setItem('rr_geocache', JSON.stringify(geocodeCache)); } catch (e) {}
}

// ============================================================
// Upload handling (legacy flow — step 8 will rebuild the UI)
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  var uploadBox = document.getElementById('upload-box');
  var fileInput = document.getElementById('file-input');

  if (uploadBox && fileInput) {
    uploadBox.addEventListener('click', function() { fileInput.click(); });
    uploadBox.addEventListener('dragover', function(e) { e.preventDefault(); uploadBox.classList.add('dragover'); });
    uploadBox.addEventListener('dragleave', function() { uploadBox.classList.remove('dragover'); });
    uploadBox.addEventListener('drop', function(e) {
      e.preventDefault();
      uploadBox.classList.remove('dragover');
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener('change', function() {
      if (fileInput.files.length) handleFile(fileInput.files[0]);
    });
  }

  document.querySelectorAll('.rr-admin-tab').forEach(function(t) {
    t.addEventListener('click', function() {
      showAdminScreen(t.getAttribute('data-tab'));
    });
  });

  var cancelBtn = document.getElementById('upload-cancel-btn');
  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() {
      geocodedStops = [];
      routeEstimate = null;
      setUploadStage('idle');
    });
  }

  loadSavedRoutes();
});

function setUploadStage(name) {
  document.querySelectorAll('.rr-upload-stage').forEach(function(s) {
    s.hidden = s.getAttribute('data-stage') !== name;
  });
}

function setProcessingStatus(pct) {
  var label, sub;
  if (pct < 40)       { label = 'Reading file…';       sub = '… preparing rows'; }
  else if (pct < 80)  { label = 'Geocoding stops…';    sub = '… looking up addresses'; }
  else                { label = 'Optimizing route…';   sub = 'Running nearest-neighbor solver'; }
  var lblEl = document.getElementById('upload-status-label');
  var subEl = document.getElementById('upload-substatus');
  if (lblEl) lblEl.textContent = label;
  if (subEl) subEl.textContent = sub;
}

async function handleFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (!['csv', 'xlsx', 'xls'].includes(ext)) {
    showStatus('Please upload a CSV or Excel file.', 'error');
    return;
  }

  setUploadStage('processing');
  setProcessingStatus(0);
  updateProgress(0);

  try {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

    if (!rows || rows.length === 0) {
      setUploadStage('idle');
      showStatus('File is empty.', 'error');
      return;
    }

    var subEl = document.getElementById('upload-substatus');
    if (subEl) subEl.textContent = rows.length + ' rows detected';

    const stops = [];
    const colMap = { name: null, address: null, city: null, state: null, zip: null, street: null, suite: null };
    if (rows.length > 0) {
      const keys = Object.keys(rows[0]);
      for (const key of keys) {
        const k = key.toLowerCase().trim();
        if (!colMap.name && (k.includes('company') || k.includes('business') || k.includes('customer') || k === 'name' || k.includes('client'))) colMap.name = key;
        if (!colMap.address && (k.includes('address') || k.includes('location') || k.includes('destination'))) colMap.address = key;
        if (!colMap.street && (k.includes('street') || k === 'st' || k.includes('addr line') || k.includes('address 1') || k.includes('addr1'))) colMap.street = key;
        if (!colMap.suite && (k.includes('suite') || k.includes('unit') || k.includes('apt') || k.includes('ste') || k.includes('room') || k.includes('floor'))) colMap.suite = key;
        if (!colMap.city && (k.includes('city') || k.includes('town') || k.includes('municipality') || k.includes('locale'))) colMap.city = key;
        if (!colMap.state && (k.includes('state') || k.includes('province') || (k === 'st' && !colMap.street))) colMap.state = key;
        if (!colMap.zip && (k.includes('zip') || k.includes('postal') || k.includes('post code'))) colMap.zip = key;
      }
      if (!colMap.name) {
        for (const key of keys) {
          if (key.toLowerCase().trim().includes('name')) { colMap.name = key; break; }
        }
      }
    }

    for (const row of rows) {
      const keys = Object.keys(row);
      let name = colMap.name ? String(row[colMap.name] || '').trim() : '';
      let street = colMap.street ? String(row[colMap.street] || '').trim() : '';
      let address = colMap.address ? String(row[colMap.address] || '').trim() : '';
      let suite = colMap.suite ? String(row[colMap.suite] || '').trim() : '';
      let city = colMap.city ? String(row[colMap.city] || '').trim() : '';
      let st = colMap.state ? String(row[colMap.state] || '').trim() : '';
      let zip = colMap.zip ? String(row[colMap.zip] || '').trim() : '';

      if (!address && street) address = street;
      if (!name && !address && keys.length >= 2) {
        name = String(row[keys[0]]).trim();
        address = String(row[keys[1]]).trim();
      }
      if (!name && address) name = address;
      if (name && !address) address = name;

      if (name && (address || street)) {
        const rawStreet = address || street;
        stops.push({ name, rawStreet, suite, city, zip, state: st });
      }
    }

    if (stops.length === 0) {
      setUploadStage('idle');
      showStatus('No valid stops found. Need columns for company name and address.', 'error');
      return;
    }

    geocodedStops = [];
    const errors = [];
    let needsDelay = false;

    for (let i = 0; i < stops.length; i++) {
      // Geocoding occupies 40–80% of the total progress bar
      const pct = 40 + (i / stops.length) * 40;
      updateProgress(pct);
      setProcessingStatus(pct);
      var sub = document.getElementById('upload-substatus');
      if (sub) sub.textContent = i + ' / ' + stops.length + ' addresses found';

      const s = stops[i];
      const cacheKey = (s.rawStreet + '|' + (s.zip || '')).toLowerCase().trim();

      function buildAddr(geoCity) {
        let addr = s.rawStreet;
        if (s.suite) addr += ' ' + s.suite;
        const displayCity = s.city || geoCity || '';
        if (displayCity) addr += ', ' + displayCity;
        addr += ', ' + (s.state || 'Alabama') + ' ' + (s.zip || '');
        return addr;
      }

      if (geocodeCache[cacheKey]) {
        const cached = geocodeCache[cacheKey];
        geocodedStops.push({ name: s.name, address: buildAddr(cached.city), lat: cached.lat, lng: cached.lng });
        continue;
      }

      let found = false;
      try {
        if (needsDelay) await sleep(1000);
        needsDelay = true;
        const result = await geocodeStructured(s.rawStreet, s.zip || '35242');
        geocodeCache[cacheKey] = result;
        geocodedStops.push({ name: s.name, address: buildAddr(result.city), lat: result.lat, lng: result.lng });
        found = true;
      } catch (err) {}

      if (!found) {
        try {
          if (needsDelay) await sleep(1000);
          needsDelay = true;
          const parts = [s.rawStreet];
          if (s.city) parts.push(s.city);
          parts.push(s.state || 'Alabama');
          if (s.zip) parts.push(s.zip);
          const result = await geocodeAddress(parts.join(', '));
          geocodeCache[cacheKey] = result;
          geocodedStops.push({ name: s.name, address: buildAddr(result.city), lat: result.lat, lng: result.lng });
          found = true;
        } catch (err2) {}
      }

      if (!found && s.name) {
        try {
          if (needsDelay) await sleep(1000);
          needsDelay = true;
          const query = s.name + (s.city ? ', ' + s.city : '') + ', Alabama';
          const result = await geocodeAddress(query);
          geocodeCache[cacheKey] = result;
          geocodedStops.push({ name: s.name, address: buildAddr(result.city), lat: result.lat, lng: result.lng });
          found = true;
        } catch (err3) {}
      }

      if (!found && s.zip) {
        try {
          if (needsDelay) await sleep(1000);
          needsDelay = true;
          const result = await geocodeAddress(s.zip + ', Alabama');
          geocodeCache[cacheKey] = result;
          geocodedStops.push({ name: s.name, address: buildAddr(result.city), lat: result.lat, lng: result.lng });
          found = true;
        } catch (err4) {}
      }

      if (!found) errors.push(s.name);
    }

    saveGeoCache();
    updateProgress(85);
    setProcessingStatus(85);

    if (geocodedStops.length === 0) {
      setUploadStage('idle');
      showStatus('Could not find any addresses on the map.', 'error');
      return;
    }

    geocodedStops = optimizeRoute(geocodedStops);
    routeEstimate = calculateTripEstimate(geocodedStops);
    updateProgress(100);
    setProcessingStatus(100);

    // Brief pause so the ring hits 100% before the view swaps
    await sleep(250);

    renderReadyBanner(errors);
    renderEstimate();
    renderStopsPreview();
    document.getElementById('route-name').value = file.name.replace(/\.(csv|xlsx|xls)$/i, '');
    setUploadStage('ready');

  } catch (err) {
    setUploadStage('idle');
    showStatus('Failed to read file.', 'error');
    console.error(err);
  }
}

// ============================================================
// Estimate & route math
// ============================================================
function calculateTripEstimate(stops) {
  let straightLineMiles = 0;
  for (let i = 0; i < stops.length - 1; i++) {
    straightLineMiles += distance(stops[i], stops[i + 1]);
  }
  const totalMiles = straightLineMiles * 1.3;
  const avgSpeedMph = 25;
  const drivingHours = totalMiles / avgSpeedMph;
  const deliveryMinPerStop = 5;
  const deliveryHours = (stops.length * deliveryMinPerStop) / 60;
  const totalHours = drivingHours + deliveryHours;
  const hourlyRate = 20;
  const gasPerMile = 0.18;
  const cushionPct = 0.25;
  const laborCost = totalHours * hourlyRate;
  const gasCost = totalMiles * gasPerMile;
  const subtotal = laborCost + gasCost;
  const cushion = subtotal * cushionPct;
  const suggestedPrice = subtotal + cushion;
  const perStop = suggestedPrice / stops.length;

  return {
    totalMiles, drivingHours, deliveryHours, totalHours,
    gasCost, laborCost, cushion, suggestedPrice, perStop,
    stopCount: stops.length
  };
}

function renderReadyBanner(errors) {
  var banner = document.getElementById('upload-banner');
  var msg = document.getElementById('upload-banner-msg');
  if (!banner || !msg) return;
  if (errors && errors.length > 0) {
    banner.classList.remove('is-success');
    banner.classList.add('is-warn');
    msg.textContent = geocodedStops.length + ' of ' + (geocodedStops.length + errors.length) +
      ' stops found and optimized. Missing: ' + errors.join(', ') + '.';
  } else {
    banner.classList.remove('is-warn');
    banner.classList.add('is-success');
    msg.textContent = 'All ' + geocodedStops.length + ' stops found and optimized.';
  }
}

function renderEstimate() {
  if (!routeEstimate) return;
  const e = routeEstimate;
  document.getElementById('estimate-num').textContent = '$' + Math.round(e.suggestedPrice);
  document.getElementById('estimate-time').textContent = formatHoursShort(e.totalHours);
  document.getElementById('estimate-drive').textContent = e.totalMiles.toFixed(0) + ' mi';
  document.getElementById('estimate-perstop').textContent = '$' + e.perStop.toFixed(2);
  document.getElementById('estimate-breakdown').innerHTML =
    '<div>Driver pay &middot; ' + formatHoursShort(e.totalHours) + ' @ $20/hr: <strong>$' + e.laborCost.toFixed(2) + '</strong></div>' +
    '<div>Gas &middot; ' + e.totalMiles.toFixed(0) + ' mi @ $0.18: <strong>$' + e.gasCost.toFixed(2) + '</strong></div>' +
    '<div>25% cushion: <strong>$' + e.cushion.toFixed(2) + '</strong></div>';
}

function formatHoursShort(h) {
  var hrs = Math.floor(h);
  var mins = Math.round((h - hrs) * 60);
  if (hrs === 0) return mins + ' min';
  return hrs + 'h ' + mins + 'm';
}

function formatHours(h) {
  var hrs = Math.floor(h);
  var mins = Math.round((h - hrs) * 60);
  if (hrs === 0) return mins + ' min';
  return hrs + 'h ' + mins + 'm';
}

async function geocodeStructured(street, zip) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1' +
    '&street=' + encodeURIComponent(street) +
    '&postalcode=' + encodeURIComponent(zip) +
    '&state=Alabama&country=US&limit=1';
  const res = await fetch(url, { headers: { 'User-Agent': 'RouteRunnerApp/1.0' } });
  const results = await res.json();
  if (results.length > 0) {
    const r = results[0];
    const ad = r.address || {};
    const city = ad.city || ad.town || ad.village || ad.hamlet || ad.county || '';
    return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), city };
  }
  throw new Error('Not found: ' + street + ' ' + zip);
}

async function geocodeAddress(address) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=' +
    encodeURIComponent(address) + '&limit=1&countrycodes=us' +
    '&viewbox=-88.5,35.0,-84.9,30.2&bounded=1';
  const res = await fetch(url, { headers: { 'User-Agent': 'RouteRunnerApp/1.0' } });
  const results = await res.json();
  if (results.length > 0) {
    const r = results[0];
    const ad = r.address || {};
    const city = ad.city || ad.town || ad.village || ad.hamlet || ad.county || '';
    return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), city };
  }
  throw new Error('Not found: ' + address);
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

function updateProgress(pct) {
  pct = Math.max(0, Math.min(100, pct));
  var numEl = document.getElementById('upload-ring-num');
  var ring = document.getElementById('upload-ring-fg');
  if (numEl) numEl.textContent = Math.round(pct);
  if (ring) {
    const C = 2 * Math.PI * 50;
    ring.setAttribute('stroke-dasharray', C.toFixed(3));
    ring.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(3));
  }
}

function optimizeRoute(stops, origin) {
  if (stops.length <= 2) return stops;
  const used = new Set();
  const ordered = [];
  let currentIdx = 0;
  if (origin) {
    let nearestDist = Infinity;
    for (let i = 0; i < stops.length; i++) {
      const d = distance(origin, stops[i]);
      if (d < nearestDist) { nearestDist = d; currentIdx = i; }
    }
  } else {
    let maxLat = -Infinity;
    for (let i = 0; i < stops.length; i++) {
      if (stops[i].lat > maxLat) { maxLat = stops[i].lat; currentIdx = i; }
    }
  }
  used.add(currentIdx);
  ordered.push(stops[currentIdx]);
  while (ordered.length < stops.length) {
    let nearest = -1, nearestDist = Infinity;
    for (let i = 0; i < stops.length; i++) {
      if (used.has(i)) continue;
      const d = distance(stops[currentIdx], stops[i]);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
    }
    used.add(nearest);
    ordered.push(stops[nearest]);
    currentIdx = nearest;
  }
  return ordered;
}

function distance(a, b) {
  const R = 3959;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  const x = s1 * s1 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * s2 * s2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function renderStopsPreview() {
  const listEl = document.getElementById('stops-preview-list');
  const more = document.getElementById('stops-preview-more');
  const moreCount = document.getElementById('stops-preview-more-count');
  const countEl = document.getElementById('stops-preview-count');
  if (!listEl) return;

  const total = geocodedStops.length;
  countEl.textContent = total;

  const visible = geocodedStops.slice(0, 5);
  listEl.innerHTML = visible.map(function(s, i) {
    return '<div class="rr-stops-preview-row">' +
      '<div class="rr-stops-preview-num">' + (i + 1) + '</div>' +
      '<div class="rr-stops-preview-text">' +
        '<div class="rr-stops-preview-name">' + escapeHtml(s.name) + '</div>' +
        '<div class="rr-stops-preview-addr">' + escapeHtml(s.address) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  if (total > 5) {
    more.hidden = false;
    moreCount.textContent = total - 5;
  } else {
    more.hidden = true;
  }
}

// ============================================================
// Save / load / delete
// ============================================================
async function saveRoute() {
  const name = document.getElementById('route-name').value.trim();
  if (!name) {
    showStatus('Please enter a route name.', 'error');
    document.getElementById('route-name').focus();
    return;
  }

  const btn = document.getElementById('btn-save');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const cleanStops = geocodedStops.map(function(s) {
      return { name: s.name, address: s.address, lat: s.lat, lng: s.lng };
    });
    await db.collection('routes').doc(name).set({
      stops: cleanStops,
      savedAt: Date.now(),
      stopCount: cleanStops.length,
      estimate: routeEstimate
    });

    btn.textContent = 'Saved!';
    btn.classList.add('is-saved');
    showStatus('Route "' + name + '" saved.', 'success');

    setTimeout(function() {
      btn.disabled = false;
      btn.textContent = 'Save Route';
      btn.classList.remove('is-saved');
      geocodedStops = [];
      routeEstimate = null;
      setUploadStage('idle');
      showAdminScreen('routes');
    }, 1500);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Save Route';
    showStatus('Failed to save. Error: ' + err.message, 'error');
    console.error(err);
  }
}

function loadSavedRoutes() {
  db.collection('routes').onSnapshot(function(snapshot) {
    cachedAdminRoutes = {};
    snapshot.docs.forEach(function(doc) {
      cachedAdminRoutes[doc.id] = doc.data();
    });
    renderSavedRoutesAdmin(cachedAdminRoutes);
  }, function(err) {
    console.error('Firestore error:', err);
  });
}

function renderSavedRoutesAdmin(routes) {
  const el = document.getElementById('saved-routes');
  const countEl = document.getElementById('routes-count');
  if (!el) return;

  const docs = Object.keys(routes || {});
  if (countEl) countEl.textContent = docs.length + ' total';

  if (docs.length === 0) {
    el.innerHTML = '<div class="rr-routes-empty">No routes yet. Upload one to get started.</div>';
    return;
  }

  docs.sort(function(a, b) { return (routes[b].savedAt || 0) - (routes[a].savedAt || 0); });

  el.innerHTML = docs.map(function(name) {
    const r = routes[name];
    const est = r.estimate;
    const stats = r.stopCount + ' stops' +
      (est ? ' · ' + formatHoursShort(est.totalHours) + ' · $' + Math.round(est.suggestedPrice) : '');

    return '<div class="rr-route-row">' +
      '<div class="rr-route-row-top">' +
        '<div class="rr-route-row-info">' +
          '<div class="rr-route-row-status-wrap">' +
            '<span class="rr-route-row-status">Idle</span>' +
          '</div>' +
          '<div class="rr-route-row-name">' + escapeHtml(name) + '</div>' +
          '<div class="rr-route-row-stats rr-mono">' + stats + '</div>' +
        '</div>' +
        '<button type="button" class="rr-route-row-edit" data-edit="' + escapeHtml(name) + '">Edit</button>' +
      '</div>' +
      '<div class="rr-route-row-actions">' +
        '<button type="button" class="rr-route-row-action" data-action="duplicate" data-route="' + escapeHtml(name) + '">Duplicate</button>' +
        '<button type="button" class="rr-route-row-action" data-action="export" data-route="' + escapeHtml(name) + '">Export</button>' +
        '<button type="button" class="rr-route-row-action is-delete" data-action="delete" data-route="' + escapeHtml(name) + '">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');

  el.querySelectorAll('.rr-route-row-edit[data-edit]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      if (typeof openEditRoute === 'function') openEditRoute(btn.getAttribute('data-edit'));
    });
  });

  el.querySelectorAll('.rr-route-row-action[data-action]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      const name = btn.getAttribute('data-route');
      const action = btn.getAttribute('data-action');
      if (action === 'delete') deleteRoute(name);
      else if (action === 'duplicate') duplicateRoute(name);
      else if (action === 'export') exportRoute(name);
    });
  });
}

async function duplicateRoute(name) {
  const source = cachedAdminRoutes[name];
  if (!source) return;
  let copyName = name + ' (copy)';
  let n = 2;
  while (cachedAdminRoutes[copyName]) {
    copyName = name + ' (copy ' + n + ')';
    n++;
  }
  try {
    await db.collection('routes').doc(copyName).set({
      stops: (source.stops || []).map(function(s) {
        return { name: s.name, address: s.address, lat: s.lat, lng: s.lng };
      }),
      savedAt: Date.now(),
      stopCount: source.stopCount,
      estimate: source.estimate || null
    });
    showStatus('Duplicated as "' + copyName + '".', 'success');
  } catch (err) {
    showStatus('Failed to duplicate.', 'error');
    console.error(err);
  }
}

function exportRoute(name) {
  const route = cachedAdminRoutes[name];
  if (!route || !route.stops) return;

  const rows = [['order', 'company', 'address', 'lat', 'lng']];
  route.stops.forEach(function(s, i) {
    rows.push([String(i + 1), s.name || '', s.address || '', s.lat || '', s.lng || '']);
  });
  const csv = rows.map(function(r) {
    return r.map(function(cell) {
      const v = String(cell);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    }).join(',');
  }).join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (name.replace(/[^A-Za-z0-9_-]+/g, '_') || 'route') + '.csv';
  document.body.appendChild(a);
  a.click();
  setTimeout(function() {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

async function deleteRoute(name) {
  if (!confirm('Delete "' + name + '"?')) return;
  try {
    await db.collection('routes').doc(name).delete();
    showStatus('Deleted "' + name + '".', 'info');
  } catch (err) {
    showStatus('Failed to delete.', 'error');
  }
}

function showStatus(msg, type) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'status ' + type;
  el.classList.remove('hidden');
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// Hoist for onclick="" in markup
window.saveRoute = saveRoute;
window.deleteRoute = deleteRoute;
window.showAdminScreen = showAdminScreen;
