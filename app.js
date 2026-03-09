// ============================================================
// Route Runner - Driver App (reads routes from Firebase)
// ============================================================

let state = {
  stops: [],
  geocodedStops: [],
  optimizedStops: [],
  routeData: null,
  currentStopIndex: 0,
  deliveredCount: 0,
  skippedCount: 0,
  userLocation: null,
  isPaused: false,
  watchId: null,
  routeName: ''
};

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
// FIREBASE - Load routes for driver
// ============================================================
function loadRoutesFromFirebase() {
  var msgEl = document.getElementById('no-routes-msg');
  if (msgEl) msgEl.textContent = 'Loading routes...';

  db.ref('routes').on('value', function(snapshot) {
    var routes = snapshot.val() || {};
    renderSavedRoutes(routes);
  }, function(err) {
    if (msgEl) msgEl.textContent = 'Could not load routes. Check connection.';
    console.error('Firebase error:', err);
  });
}

function renderSavedRoutes(routes) {
  var keys = Object.keys(routes || {});
  var list = document.getElementById('saved-routes-list');
  var section = document.getElementById('saved-routes-section');

  if (keys.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:#9aa0a6;padding:20px;font-size:14px;">No routes yet. Ask your admin to upload one.</p>';
    return;
  }

  section.classList.remove('hidden');

  // Sort by most recent
  keys.sort(function(a, b) { return (routes[b].savedAt || 0) - (routes[a].savedAt || 0); });

  list.innerHTML = keys.map(function(name) {
    var route = routes[name];
    var date = new Date(route.savedAt);
    var dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return '<div class="saved-route-card">' +
      '<div class="saved-route-info" onclick="loadRoute(\'' + escapeAttr(name) + '\')">' +
        '<div class="saved-route-name">' + escapeHtml(name) + '</div>' +
        '<div class="saved-route-meta">' + route.stopCount + ' stops &middot; ' + dateStr + '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function loadRoute(name) {
  db.ref('routes/' + name).once('value', function(snapshot) {
    var route = snapshot.val();
    if (!route || !route.stops) {
      alert('Route not found.');
      return;
    }

    state.routeName = name;
    state.geocodedStops = route.stops;
    state.stops = route.stops.map(function(s) {
      return { name: s.name, address: s.address, delivered: false };
    });

    renderStopsList();
    showScreen('review');
  });
}

// ============================================================
// REVIEW STOPS
// ============================================================
function renderStopsList() {
  var list = document.getElementById('stops-list');
  document.getElementById('stop-count').textContent = state.geocodedStops.length + ' stops';

  list.innerHTML = state.geocodedStops.map(function(stop, i) {
    return '<div class="stop-card" data-index="' + i + '">' +
      '<div class="stop-num">' + (i + 1) + '</div>' +
      '<div class="stop-info">' +
        '<div class="stop-name">' + escapeHtml(stop.name) + '</div>' +
        '<div class="stop-addr">' + escapeHtml(stop.address) + '</div>' +
      '</div>' +
      '<button class="stop-remove" onclick="removeStop(' + i + ')" aria-label="Remove stop">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</button>' +
    '</div>';
  }).join('');
}

function removeStop(index) {
  state.geocodedStops.splice(index, 1);
  renderStopsList();
  if (state.geocodedStops.length === 0) showScreen('upload');
}

function goToUpload() {
  state.stops = [];
  state.geocodedStops = [];
  showScreen('upload');
}

function goToReview() {
  showScreen('review');
}

// ============================================================
// ROUTE OPTIMIZATION (OSRM)
// ============================================================
async function optimizeRoute() {
  var btn = document.getElementById('btn-optimize');
  btn.disabled = true;
  btn.querySelector('.btn-content').textContent = 'Optimizing...';
  btn.querySelector('.btn-loader').classList.remove('hidden');

  try {
    var pos = await getCurrentPosition();
    state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    document.getElementById('start-label').textContent = 'GPS Location Found';
  } catch (e) {
    state.userLocation = { lat: 33.5186, lng: -86.8104 };
    document.getElementById('start-label').textContent = 'Birmingham, AL (default)';
  }

  var stopsWithStart = [
    { name: 'Start', address: 'Current Location', lat: state.userLocation.lat, lng: state.userLocation.lng, isStart: true }
  ].concat(state.geocodedStops);

  try {
    var coords = stopsWithStart.map(function(s) { return s.lng + ',' + s.lat; }).join(';');
    var url = 'https://router.project-osrm.org/trip/v1/driving/' + coords +
      '?overview=full&geometries=geojson&steps=true&annotations=true&source=first&roundtrip=false';

    var result;
    try {
      var res = await fetch(url);
      result = await res.json();
    } catch (e) {
      result = { code: 'Error' };
    }

    var routeData;

    if (result.code === 'Ok') {
      var waypoints = result.waypoints;
      var orderedStops = new Array(stopsWithStart.length);
      for (var i = 0; i < waypoints.length; i++) {
        orderedStops[waypoints[i].waypoint_index] = stopsWithStart[i];
      }

      var legs = result.trips[0].legs;
      var directions = [];
      for (var i = 0; i < legs.length; i++) {
        var legSteps = legs[i].steps.map(function(step) {
          return {
            instruction: formatInstruction(step),
            distance: step.distance,
            duration: step.duration,
            name: step.name || '',
            maneuver: step.maneuver
          };
        });
        directions.push({
          toStop: i + 1,
          stopName: orderedStops[i + 1] ? orderedStops[i + 1].name : '',
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
        directions: directions
      };
    } else {
      routeData = await getSimpleRoute(stopsWithStart);
    }

    state.routeData = routeData;
    state.optimizedStops = routeData.stops;
    state.currentStopIndex = 1;
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
  var coords = stops.map(function(s) { return s.lng + ',' + s.lat; }).join(';');
  var url = 'https://router.project-osrm.org/route/v1/driving/' + coords +
    '?overview=full&geometries=geojson&steps=true';

  var res = await fetch(url);
  var result = await res.json();

  if (result.code !== 'Ok') throw new Error('Could not calculate route');

  var route = result.routes[0];
  var legs = route.legs;
  var directions = [];
  for (var i = 0; i < legs.length; i++) {
    var legSteps = legs[i].steps.map(function(step) {
      return {
        instruction: formatInstruction(step),
        distance: step.distance,
        duration: step.duration,
        name: step.name || '',
        maneuver: step.maneuver
      };
    });
    directions.push({
      toStop: i + 1,
      stopName: stops[i + 1] ? stops[i + 1].name : '',
      steps: legSteps,
      distance: legs[i].distance,
      duration: legs[i].duration
    });
  }

  return {
    stops: stops,
    geometry: route.geometry,
    totalDistance: route.distance,
    totalDuration: route.duration,
    directions: directions
  };
}

function formatInstruction(step) {
  var type = step.maneuver ? step.maneuver.type : '';
  var modifier = step.maneuver ? step.maneuver.modifier || '' : '';
  var name = step.name || 'the road';

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
  var btn = document.getElementById('btn-optimize');
  btn.disabled = false;
  btn.querySelector('.btn-content').textContent = 'Optimize Route';
  btn.querySelector('.btn-loader').classList.add('hidden');
}

function getCurrentPosition() {
  return new Promise(function(resolve, reject) {
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
    var coords = state.routeData.geometry.coordinates.map(function(c) { return [c[1], c[0]]; });
    L.polyline(coords, { color: '#1a73e8', weight: 4, opacity: 0.8 }).addTo(map);
  }

  var bounds = L.latLngBounds();
  state.optimizedStops.forEach(function(stop, i) {
    var latlng = [stop.lat, stop.lng];
    bounds.extend(latlng);

    var isStart = stop.isStart;
    var marker = L.marker(latlng, {
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
  var totalMiles = (state.routeData.totalDistance / 1609.34).toFixed(1);
  var totalMins = Math.round(state.routeData.totalDuration / 60);
  document.getElementById('route-stats').textContent = totalMiles + ' mi | ' + totalMins + ' min';

  var list = document.getElementById('route-stops-list');
  var stops = state.optimizedStops;

  list.innerHTML = stops.map(function(stop, i) {
    if (stop.isStart) {
      return '<div class="route-stop-card">' +
        '<div class="route-stop-marker"><div class="marker-dot" style="background:#5f6368">S</div><div class="marker-line"></div></div>' +
        '<div class="route-stop-info"><div class="name">Starting Point</div><div class="addr">Your current location</div></div></div>';
    }

    var legInfo = state.routeData.directions && state.routeData.directions[i - 1]
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
  var stop = state.optimizedStops[state.currentStopIndex];
  if (!stop) {
    tripComplete();
    return;
  }

  document.getElementById('nav-stop-number').textContent = state.currentStopIndex;
  document.getElementById('nav-company').textContent = stop.name;
  document.getElementById('nav-address').textContent = stop.address;

  var fromStop = state.userLocation || state.optimizedStops[state.currentStopIndex - 1] || state.optimizedStops[0];

  try {
    var coords = fromStop.lng + ',' + fromStop.lat + ';' + stop.lng + ',' + stop.lat;
    var url = 'https://router.project-osrm.org/route/v1/driving/' + coords +
      '?overview=full&geometries=geojson&steps=true';

    var res = await fetch(url);
    var result = await res.json();

    if (result.code === 'Ok') {
      var route = result.routes[0];
      var routeData = {
        geometry: route.geometry,
        distance: route.distance,
        duration: route.duration,
        steps: route.legs[0].steps.map(function(step) {
          return {
            instruction: formatInstruction(step),
            distance: step.distance,
            duration: step.duration,
            name: step.name || '',
            maneuver: step.maneuver,
            geometry: step.geometry
          };
        })
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

  if (navRouteLayer) navMap.removeLayer(navRouteLayer);
  navMap.eachLayer(function(layer) {
    if (layer instanceof L.Marker || layer instanceof L.CircleMarker) {
      navMap.removeLayer(layer);
    }
  });

  if (routeData.geometry) {
    var coords = routeData.geometry.coordinates.map(function(c) { return [c[1], c[0]]; });
    navRouteLayer = L.polyline(coords, { color: '#1a73e8', weight: 5, opacity: 0.9 }).addTo(navMap);
  }

  L.marker([targetStop.lat, targetStop.lng], {
    icon: L.divIcon({
      className: '',
      html: '<div class="custom-marker current">' + state.currentStopIndex + '</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    })
  }).addTo(navMap).bindPopup('<strong>' + escapeHtml(targetStop.name) + '</strong>');

  if (state.userLocation) {
    userMarker = L.circleMarker([state.userLocation.lat, state.userLocation.lng], {
      radius: 8, fillColor: '#4285f4', fillOpacity: 1, color: 'white', weight: 2
    }).addTo(navMap);
  }

  var bounds = L.latLngBounds([[targetStop.lat, targetStop.lng]]);
  if (state.userLocation) bounds.extend([state.userLocation.lat, state.userLocation.lng]);
  navMap.fitBounds(bounds, { padding: [60, 60] });

  var mins = Math.round(routeData.duration / 60);
  document.getElementById('nav-eta').textContent = mins < 1 ? '<1' : mins;
}

function displayNavDirections(routeData) {
  if (!routeData.steps) return;

  var firstStep = routeData.steps[0];
  if (firstStep) {
    document.getElementById('direction-text').textContent = firstStep.instruction;
    document.getElementById('direction-distance').textContent = formatDistance(firstStep.distance);
    updateDirectionIcon(firstStep.maneuver);
  }

  var stepsContainer = document.getElementById('nav-steps');
  stepsContainer.innerHTML = routeData.steps
    .filter(function(s) { return s.instruction !== 'Arrive at destination' || routeData.steps.length <= 2; })
    .slice(0, 8)
    .map(function(step) {
      return '<div class="nav-step"><span class="step-text">' + step.instruction +
        '</span><span class="step-dist">' + formatDistance(step.distance) + '</span></div>';
    }).join('');
}

function updateDirectionIcon(maneuver) {
  var iconEl = document.getElementById('direction-icon');
  var modifier = maneuver ? maneuver.modifier || '' : '';

  var svg = '';
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
      function(pos) {
        state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        updateUserMarker();
        checkProximity();
      },
      function(err) { console.log('GPS error:', err.message); },
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
  var stop = state.optimizedStops[state.currentStopIndex];
  if (!stop || !state.userLocation) return;

  var dist = getDistanceMeters(
    state.userLocation.lat, state.userLocation.lng,
    stop.lat, stop.lng
  );

  if (dist < 100) showArrivedScreen();
}

function getDistanceMeters(lat1, lng1, lat2, lng2) {
  var R = 6371000;
  var dLat = (lat2 - lat1) * Math.PI / 180;
  var dLng = (lng2 - lng1) * Math.PI / 180;
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ============================================================
// DELIVERY ACTIONS
// ============================================================
function showArrivedScreen() {
  var stop = state.optimizedStops[state.currentStopIndex];
  var totalStops = state.optimizedStops.length - 1;

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

  var totalStops = state.optimizedStops.length - 1;
  document.getElementById('paused-done').textContent = state.deliveredCount;
  document.getElementById('paused-total').textContent = totalStops;

  var nextStop = state.optimizedStops[state.currentStopIndex];
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
  document.getElementById('route-map').innerHTML = '';
  document.getElementById('nav-map').innerHTML = '';
  showScreen('upload');
}

// ============================================================
// LOCAL STORAGE - Save/Restore Trip Progress
// ============================================================
function saveProgress() {
  var data = {
    optimizedStops: state.optimizedStops,
    routeData: state.routeData,
    currentStopIndex: state.currentStopIndex,
    deliveredCount: state.deliveredCount,
    skippedCount: state.skippedCount,
    userLocation: state.userLocation,
    routeName: state.routeName,
    savedAt: Date.now()
  };
  localStorage.setItem('routerunner_progress', JSON.stringify(data));
}

function clearProgress() {
  localStorage.removeItem('routerunner_progress');
}

function checkSavedProgress() {
  var saved = localStorage.getItem('routerunner_progress');
  if (!saved) return;

  try {
    var data = JSON.parse(saved);
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
        state.routeName = data.routeName || '';

        document.getElementById('paused-done').textContent = state.deliveredCount;
        document.getElementById('paused-total').textContent = state.optimizedStops.length - 1;
        var nextStop = state.optimizedStops[state.currentStopIndex];
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
  var miles = meters / 1609.34;
  if (miles < 0.1) return Math.round(meters * 3.28084) + ' ft';
  return miles.toFixed(1) + ' mi';
}

function formatDuration(seconds) {
  var mins = Math.round(seconds / 60);
  if (mins < 60) return mins + ' min';
  var hrs = Math.floor(mins / 60);
  var rem = mins % 60;
  return hrs + 'h ' + rem + 'm';
}

function escapeHtml(str) {
  var d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  loadRoutesFromFirebase();
  checkSavedProgress();
});
