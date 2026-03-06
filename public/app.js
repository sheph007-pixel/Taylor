// ============================================================
// Route Runner - Delivery Route Planner
// ============================================================

let state = {
  stops: [],           // Raw stops from upload
  geocodedStops: [],   // Stops with lat/lng
  optimizedStops: [],  // Stops in optimized order
  routeData: null,     // Full route data from server
  currentStopIndex: 0, // Current stop being navigated to
  deliveredCount: 0,
  skippedCount: 0,
  userLocation: null,
  isPaused: false,
  watchId: null
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

  // Initialize maps when shown
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
// FILE UPLOAD
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

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      hideLoading();
      showStatus(data.error, 'error');
      return;
    }

    state.stops = data.stops;
    showStatus(`Found ${data.count} stops`, 'success');
    hideLoading();

    // Go to geocode
    showLoading('Finding addresses on map...');
    await geocodeStops();
    hideLoading();

    if (state.geocodedStops.length > 0) {
      renderStopsList();
      showScreen('review');
    }
  } catch (err) {
    hideLoading();
    showStatus('Upload failed. Please try again.', 'error');
    console.error(err);
  }
}

function showStatus(msg, type) {
  uploadStatus.textContent = msg;
  uploadStatus.className = 'upload-status ' + type;
  uploadStatus.classList.remove('hidden');
}

// ============================================================
// GEOCODING
// ============================================================
async function geocodeStops() {
  try {
    const res = await fetch('/api/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stops: state.stops })
    });
    const data = await res.json();

    state.geocodedStops = data.stops;

    if (data.errors && data.errors.length > 0) {
      const errNames = data.errors.map(e => e.name).join(', ');
      showStatus(`Could not find: ${errNames}. ${data.stops.length} stops ready.`, 'error');
    }

    if (state.geocodedStops.length === 0) {
      hideLoading();
      showStatus('No addresses could be found on the map. Please check your file.', 'error');
    }
  } catch (err) {
    hideLoading();
    showStatus('Failed to find addresses. Please try again.', 'error');
    console.error(err);
  }
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
  if (state.geocodedStops.length === 0) {
    showScreen('upload');
  }
}

function goToUpload() {
  state.stops = [];
  state.geocodedStops = [];
  fileInput.value = '';
  uploadStatus.classList.add('hidden');
  showScreen('upload');
}

function goToReview() {
  showScreen('review');
}

// ============================================================
// ROUTE OPTIMIZATION
// ============================================================
async function optimizeRoute() {
  const btn = document.getElementById('btn-optimize');
  btn.disabled = true;
  btn.querySelector('.btn-content').textContent = 'Optimizing...';
  btn.querySelector('.btn-loader').classList.remove('hidden');

  // Get user's current location first
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
    const res = await fetch('/api/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stops: stopsWithStart })
    });
    const data = await res.json();

    if (!res.ok) {
      alert(data.error || 'Failed to optimize route');
      resetOptimizeBtn();
      return;
    }

    state.routeData = data;
    state.optimizedStops = data.stops;
    state.currentStopIndex = 1; // Skip start point
    state.deliveredCount = 0;
    state.skippedCount = 0;

    renderRouteOverview();
    showScreen('route');
  } catch (err) {
    alert('Failed to calculate route. Please try again.');
    console.error(err);
  }

  resetOptimizeBtn();
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

  // Draw route line
  if (state.routeData.geometry) {
    const coords = state.routeData.geometry.coordinates.map(c => [c[1], c[0]]);
    L.polyline(coords, { color: '#1a73e8', weight: 4, opacity: 0.8 }).addTo(map);
  }

  // Add markers
  const bounds = L.latLngBounds();
  state.optimizedStops.forEach((stop, i) => {
    const latlng = [stop.lat, stop.lng];
    bounds.extend(latlng);

    const isStart = stop.isStart;
    const marker = L.marker(latlng, {
      icon: L.divIcon({
        className: '',
        html: `<div class="custom-marker ${isStart ? 'start' : ''}">${isStart ? 'S' : i}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14]
      })
    }).addTo(map);

    if (!isStart) {
      marker.bindPopup(`<strong>${stop.name}</strong><br>${stop.address}`);
    }
  });

  map.fitBounds(bounds, { padding: [30, 30] });
}

function renderRouteOverview() {
  const totalMiles = (state.routeData.totalDistance / 1609.34).toFixed(1);
  const totalMins = Math.round(state.routeData.totalDuration / 60);
  document.getElementById('route-stats').textContent = `${totalMiles} mi | ${totalMins} min`;

  const list = document.getElementById('route-stops-list');
  const stops = state.optimizedStops;

  list.innerHTML = stops.map((stop, i) => {
    if (stop.isStart) {
      return `
        <div class="route-stop-card">
          <div class="route-stop-marker">
            <div class="marker-dot" style="background:#5f6368">S</div>
            <div class="marker-line"></div>
          </div>
          <div class="route-stop-info">
            <div class="name">Starting Point</div>
            <div class="addr">Your current location</div>
          </div>
        </div>`;
    }

    const legInfo = state.routeData.directions && state.routeData.directions[i - 1]
      ? formatDuration(state.routeData.directions[i - 1].duration) + ' | ' +
        formatDistance(state.routeData.directions[i - 1].distance)
      : '';

    return `
      <div class="route-stop-card">
        <div class="route-stop-marker">
          <div class="marker-dot">${i}</div>
          <div class="marker-line"></div>
        </div>
        <div class="route-stop-info">
          <div class="name">${escapeHtml(stop.name)}</div>
          <div class="addr">${escapeHtml(stop.address)}</div>
          ${legInfo ? `<div class="leg-info">${legInfo}</div>` : ''}
        </div>
      </div>`;
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

  // Update UI
  const stopNum = state.currentStopIndex;
  const totalStops = state.optimizedStops.length - 1; // minus start
  document.getElementById('nav-stop-number').textContent = stopNum;
  document.getElementById('nav-company').textContent = stop.name;
  document.getElementById('nav-address').textContent = stop.address;

  // Get route to this stop
  const fromStop = state.currentStopIndex > 0
    ? (state.userLocation || state.optimizedStops[state.currentStopIndex - 1])
    : state.optimizedStops[0];

  try {
    const res = await fetch('/api/route-segment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: fromStop, to: stop })
    });
    const data = await res.json();

    if (res.ok) {
      displayNavRoute(data, stop);
      displayNavDirections(data);
    }
  } catch (err) {
    console.error('Nav route error:', err);
  }
}

function displayNavRoute(routeData, targetStop) {
  if (!navMap) return;

  // Clear previous route
  if (navRouteLayer) navMap.removeLayer(navRouteLayer);
  navMap.eachLayer(layer => {
    if (layer instanceof L.Marker) navMap.removeLayer(layer);
  });

  // Re-add tile layer if needed
  if (navMap._layers && Object.keys(navMap._layers).length <= 1) {
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png').addTo(navMap);
  }

  // Draw route
  if (routeData.geometry) {
    const coords = routeData.geometry.coordinates.map(c => [c[1], c[0]]);
    navRouteLayer = L.polyline(coords, { color: '#1a73e8', weight: 5, opacity: 0.9 }).addTo(navMap);
  }

  // Destination marker
  L.marker([targetStop.lat, targetStop.lng], {
    icon: L.divIcon({
      className: '',
      html: `<div class="custom-marker current">${state.currentStopIndex}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    })
  }).addTo(navMap).bindPopup(`<strong>${targetStop.name}</strong>`);

  // User location marker
  if (state.userLocation) {
    if (userMarker) navMap.removeLayer(userMarker);
    userMarker = L.circleMarker([state.userLocation.lat, state.userLocation.lng], {
      radius: 8,
      fillColor: '#4285f4',
      fillOpacity: 1,
      color: 'white',
      weight: 2
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

  // Top direction bar
  const firstStep = routeData.steps[0];
  if (firstStep) {
    document.getElementById('direction-text').textContent = firstStep.instruction;
    document.getElementById('direction-distance').textContent = formatDistance(firstStep.distance);
    updateDirectionIcon(firstStep.maneuver);
  }

  // Step list
  const stepsContainer = document.getElementById('nav-steps');
  stepsContainer.innerHTML = routeData.steps
    .filter(s => s.instruction !== 'Arrive at destination' || routeData.steps.length <= 2)
    .slice(0, 8)
    .map(step => `
      <div class="nav-step">
        <span class="step-text">${step.instruction}</span>
        <span class="step-dist">${formatDistance(step.distance)}</span>
      </div>
    `).join('');
}

function updateDirectionIcon(maneuver) {
  const iconEl = document.getElementById('direction-icon');
  const type = maneuver?.type || '';
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
      radius: 8,
      fillColor: '#4285f4',
      fillOpacity: 1,
      color: 'white',
      weight: 2
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

  // Within 100 meters = arrived
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
    stops: [],
    geocodedStops: [],
    optimizedStops: [],
    routeData: null,
    currentStopIndex: 0,
    deliveredCount: 0,
    skippedCount: 0,
    userLocation: null,
    isPaused: false,
    watchId: null
  };
  routeMap = null;
  navMap = null;
  navRouteLayer = null;
  userMarker = null;
  fileInput.value = '';
  uploadStatus.classList.add('hidden');

  // Clean up map containers
  document.getElementById('route-map').innerHTML = '';
  document.getElementById('nav-map').innerHTML = '';

  showScreen('upload');
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
    // Only restore if saved within last 24 hours
    if (Date.now() - data.savedAt > 24 * 60 * 60 * 1000) {
      clearProgress();
      return;
    }

    if (data.optimizedStops && data.currentStopIndex < data.optimizedStops.length) {
      if (confirm(`You have a saved trip with ${data.optimizedStops.length - 1} stops. Resume where you left off?`)) {
        state.optimizedStops = data.optimizedStops;
        state.routeData = data.routeData;
        state.currentStopIndex = data.currentStopIndex;
        state.deliveredCount = data.deliveredCount;
        state.skippedCount = data.skippedCount;
        state.userLocation = data.userLocation;

        // Show paused screen
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
  checkSavedProgress();
});
