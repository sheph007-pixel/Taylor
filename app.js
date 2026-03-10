// ============================================================
// Route Runner - Driver App (Waze-style)
// Full-screen map, one turn at a time, voice guidance
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
  tripEndTime: null,
  voiceEnabled: true,
  currentSteps: [],
  lastSpokenStep: -1,
  lastSpokenArrival: -1
};

var navMap = null;
var navRouteLayer = null;
var userMarker = null;
var stopMarker = null;

// ============================================================
// VOICE GUIDANCE (Web Speech API — free, built-in)
// ============================================================
function speak(text) {
  if (!state.voiceEnabled) return;
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  var msg = new SpeechSynthesisUtterance(text);
  msg.rate = 1.0;
  msg.pitch = 1.0;
  msg.volume = 1.0;
  msg.lang = 'en-US';
  window.speechSynthesis.speak(msg);
}

function toggleVoice() {
  state.voiceEnabled = !state.voiceEnabled;
  document.getElementById('voice-icon-on').style.display = state.voiceEnabled ? '' : 'none';
  document.getElementById('voice-icon-off').style.display = state.voiceEnabled ? 'none' : '';
  if (!state.voiceEnabled) window.speechSynthesis.cancel();
}

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
// LOAD ROUTE → Show preview screen (NO optimization yet)
// ============================================================
function loadRoute(name) {
  var progress = getSavedProgress(name);
  var isResume = progress && progress.currentStopIndex < progress.stops.length;

  showLoading('Loading route...');

  db.collection('routes').doc(name).get().then(function(doc) {
    if (!doc.exists) { hideLoading(); alert('Route not found.'); return; }
    var route = doc.data();
    if (!route || !route.stops || route.stops.length === 0) { hideLoading(); alert('Route has no stops.'); return; }

    if (isResume) {
      state.stops = progress.stops;
      state.currentStopIndex = progress.currentStopIndex;
      state.deliveredCount = progress.deliveredCount;
      state.skippedCount = progress.skippedCount;
      state.routeName = name;
      state.estimate = progress.estimate || null;
      state.tripStartTime = progress.tripStartTime || Date.now();
    } else {
      // Load raw stops — optimization happens on Start
      state.routeName = name;
      state.stops = route.stops;
      state.currentStopIndex = 0;
      state.deliveredCount = 0;
      state.skippedCount = 0;
      state.estimate = route.estimate || null;
      state.tripStartTime = null;
    }

    hideLoading();
    showStartScreen(isResume);
  }).catch(function(err) {
    hideLoading();
    alert('Failed to load route.');
    console.error(err);
  });
}

// ============================================================
// START SCREEN — Preview before driving
// ============================================================
function showStartScreen(isResume) {
  var total = state.stops.length;
  var remaining = total - state.currentStopIndex;

  document.getElementById('start-route-name').textContent = state.routeName;
  document.getElementById('start-stop-count').textContent = total + ' stop' + (total !== 1 ? 's' : '');

  // Estimate
  var est = state.estimate;
  if (est) {
    document.getElementById('start-estimate').textContent = '~' + formatHoursShort(est.totalHours);
    document.getElementById('start-estimate-row').style.display = '';
    document.getElementById('start-price').textContent = '$' + est.suggestedPrice.toFixed(0) + ' suggested';
    document.getElementById('start-price-row').style.display = '';
  } else {
    document.getElementById('start-estimate-row').style.display = 'none';
    document.getElementById('start-price-row').style.display = 'none';
  }

  // Build stop list
  var stopListEl = document.getElementById('start-stop-list');
  var stopsToShow = isResume ? state.stops.slice(state.currentStopIndex) : state.stops;
  stopListEl.innerHTML = stopsToShow.map(function(stop, i) {
    var num = isResume ? state.currentStopIndex + i + 1 : i + 1;
    var statusClass = '';
    if (stop.delivered) statusClass = ' delivered';
    else if (stop.skipped) statusClass = ' skipped';
    return '<div class="start-stop-item' + statusClass + '">' +
      '<div class="start-stop-num">' + num + '</div>' +
      '<div class="start-stop-info">' +
        '<div class="start-stop-name">' + escapeHtml(stop.name) + '</div>' +
        '<div class="start-stop-addr">' + escapeHtml(stop.address) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  // Resume info
  var resumeInfo = document.getElementById('start-resume-info');
  if (isResume) {
    resumeInfo.style.display = '';
    document.getElementById('start-resume-text').textContent =
      state.deliveredCount + ' delivered, ' + remaining + ' remaining';
    document.getElementById('start-go-btn').innerHTML =
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg> Resume Route';
  } else {
    resumeInfo.style.display = 'none';
    document.getElementById('start-go-btn').innerHTML =
      '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3" fill="currentColor"/></svg> Start Route';
  }

  showScreen('start');
}

// ============================================================
// START ROUTE — Optimize from current GPS, then begin
// ============================================================
function startRoute() {
  var btn = document.getElementById('start-go-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="start-btn-spinner"></span> Optimizing...';

  getDriverLocation(function(driverPos) {
    // Only optimize fresh routes (not resumed)
    if (state.tripStartTime === null && state.stops.length > 2) {
      if (driverPos) {
        state.stops = optimizeRouteFromGPS(state.stops, driverPos);
      }
    }
    state.tripStartTime = state.tripStartTime || Date.now();

    btn.disabled = false;
    showDeliveryScreen();
  });
}

function getDriverLocation(callback) {
  if (!navigator.geolocation) { callback(null); return; }
  navigator.geolocation.getCurrentPosition(
    function(pos) {
      callback({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    function() { callback(null); },
    { enableHighAccuracy: true, timeout: 5000, maximumAge: 60000 }
  );
}

function optimizeRouteFromGPS(stops, origin) {
  if (stops.length <= 1) return stops;
  var used = {};
  var ordered = [];
  var current = origin;

  for (var step = 0; step < stops.length; step++) {
    var nearest = -1, nearestDist = Infinity;
    for (var i = 0; i < stops.length; i++) {
      if (used[i]) continue;
      var d = haversineDistance(current, stops[i]);
      if (d < nearestDist) { nearestDist = d; nearest = i; }
    }
    used[nearest] = true;
    ordered.push(stops[nearest]);
    current = stops[nearest];
  }
  return ordered;
}

function haversineDistance(a, b) {
  var R = 3959;
  var dLat = (b.lat - a.lat) * Math.PI / 180;
  var dLng = (b.lng - a.lng) * Math.PI / 180;
  var s1 = Math.sin(dLat / 2), s2 = Math.sin(dLng / 2);
  var x = s1 * s1 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * s2 * s2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

// ============================================================
// DELIVERY SCREEN (Waze-style)
// ============================================================
function showDeliveryScreen() {
  var stop = state.stops[state.currentStopIndex];
  if (!stop) { tripComplete(); return; }

  var total = state.stops.length;

  // Update bottom card
  document.getElementById('delivery-company').textContent = stop.name;
  document.getElementById('delivery-address').textContent = stop.address;

  // Progress badge
  document.getElementById('nav-stop-num').textContent = state.currentStopIndex + 1;
  document.getElementById('nav-stop-total').textContent = total;

  // Progress bar
  var pct = total > 0 ? ((state.currentStopIndex) / total * 100) : 0;
  document.getElementById('delivery-progress-fill').style.width = pct + '%';

  // Reset turn bar
  document.getElementById('nav-turn-text').textContent = 'Calculating route...';
  document.getElementById('nav-turn-distance').textContent = '';
  document.getElementById('nav-turn-icon').innerHTML = getTurnIconSVG('straight');

  state.currentSteps = [];
  state.lastSpokenStep = -1;

  showScreen('nav');
  startGPSTracking();
  navigateToStop(stop);

  // Voice: announce the next stop
  speak('Stop ' + (state.currentStopIndex + 1) + ' of ' + total + '. ' + stop.name + '. ' + stop.address);
}

// ============================================================
// BIG TURN-BY-TURN DISPLAY (one step at a time)
// ============================================================
function updateTurnDisplay() {
  var steps = state.currentSteps;
  if (!steps || steps.length === 0) return;

  // Find the next meaningful step (skip depart if we have more steps)
  var nextStep = steps[0];
  if (steps.length > 1 && steps[0].maneuver.type === 'depart') {
    nextStep = steps[1];
  }

  // If the last step is arrive, show "Arrive" when it's the only step left
  if (steps.length <= 2) {
    var lastStep = steps[steps.length - 1];
    if (lastStep.maneuver.type === 'arrive') {
      nextStep = lastStep;
    }
  }

  var direction = getDirection(nextStep.maneuver);
  var instruction = formatInstruction(nextStep);
  var dist = nextStep.distance;

  document.getElementById('nav-turn-icon').innerHTML = getTurnIconSVG(direction);
  document.getElementById('nav-turn-text').textContent = instruction;
  document.getElementById('nav-turn-distance').textContent = dist > 0 ? formatDistance(dist) : '';

  // Voice: speak next turn if we haven't already
  var stepKey = instruction;
  if (stepKey !== state._lastSpokenInstruction) {
    state._lastSpokenInstruction = stepKey;
    if (dist < 500) { // within ~0.3 miles
      speak(instruction);
    } else {
      speak('In ' + formatDistance(dist) + ', ' + instruction);
    }
  }
}

function getDirection(maneuver) {
  if (!maneuver) return 'straight';
  var mod = maneuver.modifier || '';
  var type = maneuver.type || '';
  if (type === 'arrive') return 'arrive';
  if (mod.includes('left')) return 'left';
  if (mod.includes('right')) return 'right';
  if (type === 'roundabout') return 'roundabout';
  return 'straight';
}

function getTurnIconSVG(direction) {
  if (direction === 'left') {
    return '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="white" stroke-width="2.5"><polyline points="15 4 7 4 7 16"/><polyline points="11 8 7 4 3 8"/></svg>';
  }
  if (direction === 'right') {
    return '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="white" stroke-width="2.5"><polyline points="9 4 17 4 17 16"/><polyline points="13 8 17 4 21 8"/></svg>';
  }
  if (direction === 'arrive') {
    return '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="white" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  }
  if (direction === 'roundabout') {
    return '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="white" stroke-width="2.5"><circle cx="12" cy="12" r="4"/><path d="M12 16v5"/><polyline points="9 19 12 21 15 19"/></svg>';
  }
  // straight
  return '<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="white" stroke-width="2.5"><polyline points="12 19 12 5"/><polyline points="5 12 12 5 19 12"/></svg>';
}

// ============================================================
// NAVIGATION
// ============================================================
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
  navMap.fitBounds(bounds, { padding: [80, 80] });
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
      navRouteLayer = L.polyline(routeCoords, { color: '#1a73e8', weight: 6, opacity: 0.9 }).addTo(navMap);

      var mins = Math.round(route.duration / 60);
      document.getElementById('delivery-eta').textContent = mins < 1 ? '<1 min' : mins + ' min';
      document.getElementById('delivery-distance').textContent = formatDistance(route.distance);

      // Store steps for turn-by-turn
      state.currentSteps = route.legs[0].steps;
      updateTurnDisplay();

      navMap.fitBounds(L.polyline(routeCoords).getBounds(), { padding: [80, 80] });
    }
  }).catch(function(err) { console.error('Directions error:', err); });
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

  speak('Delivered! ' + (state.stops.length - state.currentStopIndex) + ' stops left.');

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

  speak('Skipped. Moving to next stop.');

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

  speak('Trip paused.');
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
// TRIP COMPLETE
// ============================================================
function tripComplete() {
  stopGPSTracking();
  state.tripEndTime = Date.now();

  var actualHours = state.tripStartTime ? (state.tripEndTime - state.tripStartTime) / 1000 / 3600 : 0;

  document.getElementById('complete-delivered').textContent = state.deliveredCount;
  document.getElementById('complete-skipped').textContent = state.skippedCount;
  document.getElementById('complete-route-name').textContent = state.routeName;
  document.getElementById('complete-time').textContent = formatHoursShort(actualHours);

  var financialEl = document.getElementById('complete-financials');
  var est = state.estimate;

  if (est) {
    var actualLabor = actualHours * 20;
    var actualGas = est.totalMiles * 0.18;
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
    var minCharge = actualHours * 20 * 1.25;
    financialEl.innerHTML =
      '<h3>Trip Financials</h3>' +
      '<div class="financial-row"><span>Actual Time:</span><strong>' + formatHoursShort(actualHours) + '</strong></div>' +
      '<div class="financial-row"><span>Min. charge for this trip:</span><strong>$' + minCharge.toFixed(0) + '</strong></div>' +
      '<div class="financial-row hint"><span>Based on $20/hr + 25% cushion (excludes gas)</span></div>';
    financialEl.style.display = 'block';
  }

  speak('All done! ' + state.deliveredCount + ' delivered.');
  clearProgress();
  showScreen('complete');
}

function newTrip() {
  state = {
    stops: [], currentStopIndex: 0, deliveredCount: 0, skippedCount: 0,
    userLocation: null, watchId: null, routeName: '', estimate: null,
    tripStartTime: null, tripEndTime: null, voiceEnabled: true,
    currentSteps: [], lastSpokenStep: -1, lastSpokenArrival: -1
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
      // Re-fetch directions periodically as driver moves
      refreshDirectionsThrottled();
    },
    function(err) { console.log('GPS:', err.message); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}

var _lastDirectionsFetch = 0;
function refreshDirectionsThrottled() {
  var now = Date.now();
  if (now - _lastDirectionsFetch < 15000) return; // every 15s max
  _lastDirectionsFetch = now;
  var stop = state.stops[state.currentStopIndex];
  if (stop && state.userLocation) {
    fetchDirections(state.userLocation, stop);
  }
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
      radius: 10, fillColor: '#4285f4', fillOpacity: 1, color: 'white', weight: 3
    }).addTo(navMap);
  }
}

function checkProximity() {
  var stop = state.stops[state.currentStopIndex];
  if (!stop || !state.userLocation) return;
  var dist = getDistanceMeters(state.userLocation.lat, state.userLocation.lng, stop.lat, stop.lng);
  var banner = document.getElementById('arrived-banner');
  if (dist < 150) {
    banner.classList.remove('hidden');
    // Voice announce arrival once per stop
    if (state.lastSpokenArrival !== state.currentStopIndex) {
      state.lastSpokenArrival = state.currentStopIndex;
      speak("You've arrived at " + stop.name);
    }
  } else {
    banner.classList.add('hidden');
  }
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
// NAV MAP (full screen)
// ============================================================
function initNavMap() {
  if (navMap) { navMap.invalidateSize(); return; }
  navMap = L.map('nav-map', { zoomControl: false, attributionControl: false });
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
});
