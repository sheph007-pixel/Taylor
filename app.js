// ============================================================
// Route Runner - Driver App
// Simple: Tap route → Start delivering → Mark delivered → Next
// ============================================================

var state = {
  stops: [],
  currentStopIndex: 0,
  deliveredCount: 0,
  skippedCount: 0,
  userLocation: null,
  watchId: null,
  routeName: '',
  estimate: null,
  tripStartTime: null,
  tripEndTime: null
};

var navMap = null;
var navRouteLayer = null;
var userMarker = null;
var stopMarker = null;

// ============================================================
// SCREEN MANAGEMENT
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById('screen-' + id).classList.add('active');
  if (id === 'nav') {
    setTimeout(function() { initNavMap(); }, 100);
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

  db.collection('routes').onSnapshot(function(snapshot) {
    var routes = {};
    snapshot.docs.forEach(function(doc) {
      routes[doc.id] = doc.data();
    });
    renderSavedRoutes(routes);
  }, function(err) {
    if (msgEl) msgEl.textContent = 'Could not load routes. Check connection.';
    console.error('Firebase error:', err);
  });
}

function renderSavedRoutes(routes) {
  var keys = Object.keys(routes || {});
  var list = document.getElementById('saved-routes-list');

  if (keys.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:#9aa0a6;padding:20px;font-size:14px;">No routes yet. Ask your admin to upload one.</p>';
    return;
  }

  keys.sort(function(a, b) { return (routes[b].savedAt || 0) - (routes[a].savedAt || 0); });

  list.innerHTML = keys.map(function(name) {
    var route = routes[name];
    var date = new Date(route.savedAt);
    var dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    var est = route.estimate;

    // Check for saved progress
    var progress = getSavedProgress(name);
    var progressHtml = '';
    if (progress) {
      var remaining = progress.stops.length - progress.currentStopIndex;
      progressHtml = '<div class="saved-route-progress">' + progress.deliveredCount + ' done, ' + remaining + ' left</div>';
    }

    var estHtml = '';
    if (est) {
      estHtml = '<div class="saved-route-estimate">~' + formatHoursShort(est.totalHours) + ' &middot; $' + est.suggestedPrice.toFixed(0) + ' suggested</div>';
    }

    return '<div class="saved-route-card">' +
      '<div class="saved-route-info" onclick="loadRoute(\'' + escapeAttr(name) + '\')">' +
        '<div class="saved-route-name">' + escapeHtml(name) + '</div>' +
        '<div class="saved-route-meta">' + route.stopCount + ' stops &middot; ' + dateStr + '</div>' +
        estHtml +
        progressHtml +
      '</div>' +
    '</div>';
  }).join('');
}

// ============================================================
// LOAD ROUTE
// ============================================================
function loadRoute(name) {
  var progress = getSavedProgress(name);
  if (progress && progress.currentStopIndex < progress.stops.length) {
    var remaining = progress.stops.length - progress.currentStopIndex;
    if (confirm('Resume "' + name + '"? ' + progress.deliveredCount + ' delivered, ' + remaining + ' remaining.')) {
      state.stops = progress.stops;
      state.currentStopIndex = progress.currentStopIndex;
      state.deliveredCount = progress.deliveredCount;
      state.skippedCount = progress.skippedCount;
      state.routeName = name;
      state.estimate = progress.estimate || null;
      state.tripStartTime = progress.tripStartTime || Date.now();
      showDeliveryScreen();
      return;
    }
  }

  showLoading('Loading route...');

  db.collection('routes').doc(name).get().then(function(doc) {
    if (!doc.exists) { hideLoading(); alert('Route not found.'); return; }
    var route = doc.data();
    if (!route || !route.stops || route.stops.length === 0) { hideLoading(); alert('Route has no stops.'); return; }

    state.routeName = name;
    state.stops = route.stops;
    state.currentStopIndex = 0;
    state.deliveredCount = 0;
    state.skippedCount = 0;
    state.estimate = route.estimate || null;
    state.tripStartTime = Date.now();

    hideLoading();
    showDeliveryScreen();
  }).catch(function(err) {
    hideLoading();
    alert('Failed to load route.');
    console.error(err);
  });
}

// ============================================================
// DELIVERY SCREEN
// ============================================================
function showDeliveryScreen() {
  var stop = state.stops[state.currentStopIndex];
  if (!stop) { tripComplete(); return; }

  var total = state.stops.length;
  var remaining = total - state.currentStopIndex;

  document.getElementById('delivery-stop-number').textContent = state.currentStopIndex + 1;
  document.getElementById('delivery-total').textContent = total;
  document.getElementById('delivery-company').textContent = stop.name;
  document.getElementById('delivery-address').textContent = stop.address;
  document.getElementById('delivery-remaining').textContent = remaining + ' stop' + (remaining !== 1 ? 's' : '') + ' remaining';
  document.getElementById('delivery-delivered-count').textContent = state.deliveredCount + ' delivered';

  var pct = total > 0 ? ((state.currentStopIndex) / total * 100) : 0;
  document.getElementById('delivery-progress-fill').style.width = pct + '%';

  // Show elapsed time
  updateElapsedTime();

  showScreen('nav');
  startGPSTracking();
  navigateToStop(stop);
}

function updateElapsedTime() {
  if (!state.tripStartTime) return;
  var elapsed = (Date.now() - state.tripStartTime) / 1000 / 3600;
  var el = document.getElementById('delivery-elapsed');
  if (el) el.textContent = formatHoursShort(elapsed) + ' elapsed';
}

function navigateToStop(stop) {
  if (!navMap) return;

  if (navRouteLayer) { navMap.removeLayer(navRouteLayer); navRouteLayer = null; }
  if (stopMarker) { navMap.removeLayer(stopMarker); stopMarker = null; }

  stopMarker = L.marker([stop.lat, stop.lng], {
    icon: L.divIcon({
      className: '',
      html: '<div class="custom-marker current">' + (state.currentStopIndex + 1) + '</div>',
      iconSize: [32, 32],
      iconAnchor: [16, 16]
    })
  }).addTo(navMap);

  var from = state.userLocation ||
    (state.currentStopIndex > 0 ? state.stops[state.currentStopIndex - 1] : null);

  if (from) fetchDirections(from, stop);

  var bounds = L.latLngBounds([[stop.lat, stop.lng]]);
  if (state.userLocation) bounds.extend([state.userLocation.lat, state.userLocation.lng]);
  navMap.fitBounds(bounds, { padding: [60, 60] });
}

function fetchDirections(from, to) {
  var coords = from.lng + ',' + from.lat + ';' + to.lng + ',' + to.lat;
  var url = 'https://router.project-osrm.org/route/v1/driving/' + coords +
    '?overview=full&geometries=geojson&steps=true';

  fetch(url).then(function(res) { return res.json(); }).then(function(result) {
    if (result.code === 'Ok') {
      var route = result.routes[0];
      if (navRouteLayer) navMap.removeLayer(navRouteLayer);
      var routeCoords = route.geometry.coordinates.map(function(c) { return [c[1], c[0]]; });
      navRouteLayer = L.polyline(routeCoords, { color: '#1a73e8', weight: 5, opacity: 0.9 }).addTo(navMap);

      var mins = Math.round(route.duration / 60);
      document.getElementById('delivery-eta').textContent = mins < 1 ? '<1 min' : mins + ' min';
      document.getElementById('delivery-distance').textContent = formatDistance(route.distance);

      renderDirectionSteps(route.legs[0].steps);
      navMap.fitBounds(L.polyline(routeCoords).getBounds(), { padding: [60, 60] });
    }
  }).catch(function(err) { console.error('Directions error:', err); });
}

function renderDirectionSteps(steps) {
  var container = document.getElementById('delivery-steps');
  container.innerHTML = steps
    .filter(function(s) { return s.maneuver.type !== 'arrive' || steps.length <= 2; })
    .slice(0, 6)
    .map(function(step) {
      return '<div class="nav-step">' +
        '<span class="step-icon">' + getStepIcon(step.maneuver) + '</span>' +
        '<span class="step-text">' + formatInstruction(step) + '</span>' +
        '<span class="step-dist">' + formatDistance(step.distance) + '</span>' +
      '</div>';
    }).join('');
}

function getStepIcon(maneuver) {
  var mod = maneuver ? maneuver.modifier || '' : '';
  if (mod.includes('left')) return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 4 7 4 7 16"/><polyline points="11 8 7 4 3 8"/></svg>';
  if (mod.includes('right')) return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 4 17 4 17 16"/><polyline points="13 8 17 4 21 8"/></svg>';
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="12 19 12 5"/><polyline points="5 12 12 5 19 12"/></svg>';
}

function formatInstruction(step) {
  var type = step.maneuver ? step.maneuver.type : '';
  var modifier = step.maneuver ? step.maneuver.modifier || '' : '';
  var name = step.name || 'the road';
  if (type === 'depart') return 'Head ' + (modifier || 'forward') + ' on ' + name;
  if (type === 'arrive') return 'Arrive at destination';
  if (type === 'turn') return 'Turn ' + modifier + ' onto ' + name;
  if (type === 'merge') return 'Merge ' + modifier + ' onto ' + name;
  if (type === 'fork') return 'Take the ' + modifier + ' fork';
  if (type === 'roundabout') return 'At roundabout, exit onto ' + name;
  if (type === 'new name') return 'Continue onto ' + name;
  if (type === 'end of road') return 'Turn ' + modifier + ' onto ' + name;
  if (type === 'continue') return 'Continue on ' + name;
  if (modifier) return modifier.charAt(0).toUpperCase() + modifier.slice(1) + ' onto ' + name;
  return 'Continue on ' + name;
}

// ============================================================
// DELIVERY ACTIONS
// ============================================================
function markDelivered() {
  state.stops[state.currentStopIndex].delivered = true;
  state.stops[state.currentStopIndex].deliveredAt = Date.now();
  state.deliveredCount++;
  state.currentStopIndex++;
  saveProgress();

  if (state.currentStopIndex >= state.stops.length) {
    tripComplete();
  } else {
    showDeliveryScreen();
  }
}

function skipStop() {
  state.stops[state.currentStopIndex].skipped = true;
  state.skippedCount++;
  state.currentStopIndex++;
  saveProgress();

  if (state.currentStopIndex >= state.stops.length) {
    tripComplete();
  } else {
    showDeliveryScreen();
  }
}

function openInMaps() {
  var stop = state.stops[state.currentStopIndex];
  if (!stop) return;
  window.open('https://www.google.com/maps/dir/?api=1&destination=' +
    encodeURIComponent(stop.lat + ',' + stop.lng) + '&travelmode=driving', '_blank');
}

// ============================================================
// PAUSE / RESUME
// ============================================================
function pauseTrip() {
  stopGPSTracking();
  saveProgress();

  var total = state.stops.length;
  var remaining = total - state.currentStopIndex;

  document.getElementById('paused-done').textContent = state.deliveredCount;
  document.getElementById('paused-total').textContent = total;
  document.getElementById('paused-next-name').textContent =
    state.stops[state.currentStopIndex] ? state.stops[state.currentStopIndex].name : 'None';
  document.getElementById('paused-remaining').textContent = remaining + ' stops remaining';

  showScreen('paused');
}

function resumeTrip() { showDeliveryScreen(); }

function endTrip() {
  if (confirm('End trip? Progress is saved - you can resume later.')) {
    stopGPSTracking();
    saveProgress();
    showScreen('upload');
  }
}

// ============================================================
// TRIP COMPLETE — Show financials
// ============================================================
function tripComplete() {
  stopGPSTracking();
  state.tripEndTime = Date.now();

  var actualHours = state.tripStartTime ? (state.tripEndTime - state.tripStartTime) / 1000 / 3600 : 0;

  document.getElementById('complete-delivered').textContent = state.deliveredCount;
  document.getElementById('complete-skipped').textContent = state.skippedCount;
  document.getElementById('complete-route-name').textContent = state.routeName;
  document.getElementById('complete-time').textContent = formatHoursShort(actualHours);

  // Financial summary
  var financialEl = document.getElementById('complete-financials');
  var est = state.estimate;

  if (est) {
    var actualLabor = actualHours * 20;
    var actualGas = est.totalMiles * 0.18; // use estimated miles (we don't track actual GPS miles)
    var actualSubtotal = actualLabor + actualGas;
    var actualWithCushion = actualSubtotal * 1.25;

    var profitable = est.suggestedPrice >= actualSubtotal;

    financialEl.innerHTML =
      '<h3>Trip Financials</h3>' +
      '<div class="financial-row"><span>Quoted Price:</span><strong>$' + est.suggestedPrice.toFixed(0) + '</strong></div>' +
      '<div class="financial-row"><span>Actual Time:</span><strong>' + formatHoursShort(actualHours) + '</strong></div>' +
      '<div class="financial-row"><span>Est. Time:</span><span>' + formatHoursShort(est.totalHours) + '</span></div>' +
      '<div class="financial-divider"></div>' +
      '<div class="financial-row"><span>Driver Pay (' + formatHoursShort(actualHours) + ' x $20/hr):</span><strong>$' + actualLabor.toFixed(2) + '</strong></div>' +
      '<div class="financial-row"><span>Gas (' + est.totalMiles.toFixed(0) + ' mi):</span><strong>$' + actualGas.toFixed(2) + '</strong></div>' +
      '<div class="financial-row"><span>Actual Cost:</span><strong>$' + actualSubtotal.toFixed(2) + '</strong></div>' +
      '<div class="financial-divider"></div>' +
      '<div class="financial-row highlight ' + (profitable ? 'profit' : 'loss') + '">' +
        '<span>' + (profitable ? 'Profit:' : 'Loss:') + '</span>' +
        '<strong>$' + Math.abs(est.suggestedPrice - actualSubtotal).toFixed(2) + '</strong>' +
      '</div>' +
      '<div class="financial-row"><span>Should have charged:</span><strong>$' + actualWithCushion.toFixed(0) + '</strong></div>';
    financialEl.style.display = 'block';
  } else {
    // No estimate — just show time
    var minCharge = actualHours * 20 * 1.25;
    financialEl.innerHTML =
      '<h3>Trip Financials</h3>' +
      '<div class="financial-row"><span>Actual Time:</span><strong>' + formatHoursShort(actualHours) + '</strong></div>' +
      '<div class="financial-row"><span>Min. charge for this trip:</span><strong>$' + minCharge.toFixed(0) + '</strong></div>' +
      '<div class="financial-row hint"><span>Based on $20/hr + 25% cushion (excludes gas)</span></div>';
    financialEl.style.display = 'block';
  }

  clearProgress();
  showScreen('complete');
}

function newTrip() {
  state = {
    stops: [], currentStopIndex: 0, deliveredCount: 0, skippedCount: 0,
    userLocation: null, watchId: null, routeName: '', estimate: null,
    tripStartTime: null, tripEndTime: null
  };
  navMap = null; navRouteLayer = null; userMarker = null; stopMarker = null;
  document.getElementById('nav-map').innerHTML = '';
  showScreen('upload');
}

// ============================================================
// GPS TRACKING
// ============================================================
function startGPSTracking() {
  if (state.watchId) navigator.geolocation.clearWatch(state.watchId);
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    function(pos) {
      state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateUserMarker();
      var stop = state.stops[state.currentStopIndex];
      if (stop) fetchDirections(state.userLocation, stop);
    },
    function() {},
    { enableHighAccuracy: true, timeout: 8000 }
  );

  state.watchId = navigator.geolocation.watchPosition(
    function(pos) {
      state.userLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateUserMarker();
      checkProximity();
    },
    function(err) { console.log('GPS:', err.message); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}

function stopGPSTracking() {
  if (state.watchId) { navigator.geolocation.clearWatch(state.watchId); state.watchId = null; }
}

function updateUserMarker() {
  if (!navMap || !state.userLocation) return;
  if (userMarker) {
    userMarker.setLatLng([state.userLocation.lat, state.userLocation.lng]);
  } else {
    userMarker = L.circleMarker([state.userLocation.lat, state.userLocation.lng], {
      radius: 8, fillColor: '#4285f4', fillOpacity: 1, color: 'white', weight: 3
    }).addTo(navMap);
  }
}

function checkProximity() {
  var stop = state.stops[state.currentStopIndex];
  if (!stop || !state.userLocation) return;
  var dist = getDistanceMeters(state.userLocation.lat, state.userLocation.lng, stop.lat, stop.lng);
  var banner = document.getElementById('arrived-banner');
  if (dist < 150) { banner.classList.remove('hidden'); } else { banner.classList.add('hidden'); }
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
// NAV MAP
// ============================================================
function initNavMap() {
  if (navMap) { navMap.invalidateSize(); return; }
  navMap = L.map('nav-map', { zoomControl: false });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OSM' }).addTo(navMap);
  var stop = state.stops[state.currentStopIndex];
  if (stop) navigateToStop(stop);
}

// ============================================================
// PROGRESS PERSISTENCE
// ============================================================
function getProgressKey(name) { return 'rr_progress_' + (name || state.routeName); }

function saveProgress() {
  var data = {
    stops: state.stops,
    currentStopIndex: state.currentStopIndex,
    deliveredCount: state.deliveredCount,
    skippedCount: state.skippedCount,
    routeName: state.routeName,
    estimate: state.estimate,
    tripStartTime: state.tripStartTime,
    savedAt: Date.now()
  };
  try { localStorage.setItem(getProgressKey(), JSON.stringify(data)); } catch (e) {}
  try { db.collection('progress').doc(state.routeName).set(data); } catch (e) {}
}

function getSavedProgress(routeName) {
  try {
    var saved = localStorage.getItem(getProgressKey(routeName));
    if (saved) {
      var data = JSON.parse(saved);
      if (data.currentStopIndex < data.stops.length) return data;
    }
  } catch (e) {}
  return null;
}

function clearProgress() {
  try { localStorage.removeItem(getProgressKey()); } catch (e) {}
  try { db.collection('progress').doc(state.routeName).delete(); } catch (e) {}
}

function checkFirebaseProgress() {
  db.collection('progress').get().then(function(snapshot) {
    snapshot.docs.forEach(function(doc) {
      var data = doc.data();
      var key = getProgressKey(doc.id);
      if (!localStorage.getItem(key) && data.currentStopIndex < data.stops.length) {
        localStorage.setItem(key, JSON.stringify(data));
      }
    });
    loadRoutesFromFirebase();
  }).catch(function() {});
}

// ============================================================
// HELPERS
// ============================================================
function formatDistance(meters) {
  var miles = meters / 1609.34;
  if (miles < 0.1) return Math.round(meters * 3.28084) + ' ft';
  return miles.toFixed(1) + ' mi';
}

function formatHoursShort(h) {
  var hrs = Math.floor(h);
  var mins = Math.round((h - hrs) * 60);
  if (hrs === 0) return mins + ' min';
  return hrs + 'h ' + mins + 'm';
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
  checkFirebaseProgress();

  // Update elapsed time every 30 seconds
  setInterval(updateElapsedTime, 30000);
});
