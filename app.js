// ============================================================
// Route Runner - Driver App (Waze-style)
// Full-screen map, one turn at a time, voice guidance
// Routes loaded from server API (GET /api/routes)
// ============================================================

function loadVoicePref() {
  try {
    var v = localStorage.getItem('rr_voice_on');
    return v === null ? true : v === '1';
  } catch (e) { return true; }
}

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
  activeSince: null,    // ms timestamp while clock is running, null when paused
  activeSeconds: 0,     // accumulated seconds across completed active intervals
  voiceEnabled: loadVoicePref(),
  currentSteps: [],
  lastSpokenStep: -1,
  lastSpokenArrival: -1
};

var navMap = null;
var navRouteLayer = null;
var userMarker = null;
var stopMarker = null;
var cachedRoutes = {};

// ============================================================
// VOICE GUIDANCE (Web Speech API)
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
  try { localStorage.setItem('rr_voice_on', state.voiceEnabled ? '1' : '0'); } catch (e) {}
  syncVoiceUI();
  if (!state.voiceEnabled) window.speechSynthesis.cancel();
}

function syncVoiceUI() {
  var on = document.getElementById('voice-icon-on');
  var off = document.getElementById('voice-icon-off');
  var btn = document.getElementById('voice-toggle');
  if (on) on.style.display = state.voiceEnabled ? '' : 'none';
  if (off) off.style.display = state.voiceEnabled ? 'none' : '';
  if (btn) btn.classList.toggle('is-on', state.voiceEnabled);
}

// ============================================================
// ACTIVE-TIME CLOCK
// ============================================================
function startActiveClock() {
  if (state.activeSince === null) state.activeSince = Date.now();
}

function stopActiveClock() {
  if (state.activeSince !== null) {
    state.activeSeconds += (Date.now() - state.activeSince) / 1000;
    state.activeSince = null;
  }
}

function currentActiveSeconds() {
  var base = state.activeSeconds || 0;
  if (state.activeSince !== null) base += (Date.now() - state.activeSince) / 1000;
  return base;
}

function formatElapsed(secs) {
  secs = Math.max(0, Math.floor(secs));
  var h = Math.floor(secs / 3600);
  var m = Math.floor((secs % 3600) / 60);
  var s = secs % 60;
  if (h > 0) return h + 'h ' + m + 'm';
  return m + ':' + (s < 10 ? '0' + s : s);
}

var _navTimerInterval = null;
function updateNavTimer() {
  var el = document.getElementById('nav-timer');
  if (el) el.textContent = formatElapsed(currentActiveSeconds());
}

// ============================================================
// SCREEN MANAGEMENT
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(function(s) { s.classList.remove('active'); });
  document.getElementById('screen-' + id).classList.add('active');

  if (_navTimerInterval) { clearInterval(_navTimerInterval); _navTimerInterval = null; }
  if (id === 'nav') {
    updateNavTimer();
    _navTimerInterval = setInterval(updateNavTimer, 1000);
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
    cachedRoutes = {};
    snapshot.docs.forEach(function(doc) {
      cachedRoutes[doc.id] = doc.data();
    });
    renderSavedRoutes(cachedRoutes);
  }, function(err) {
    if (msgEl) msgEl.textContent = 'Could not load routes. Check connection.';
    console.error('Firebase error:', err);
  });
}

function renderSavedRoutes(routes) {
  var keys = Object.keys(routes || {});
  var list = document.getElementById('saved-routes-list');
  var sub = document.getElementById('rr-greeting-sub');

  if (keys.length === 0) {
    list.innerHTML = '<p class="rr-route-loading">Nothing on the board yet. Ask admin to load one.</p>';
    if (sub) sub.textContent = 'Nothing on the board yet. Ask admin to load one.';
    return;
  }

  keys.sort(function(a, b) { return (routes[b].savedAt || 0) - (routes[a].savedAt || 0); });

  if (sub) {
    sub.textContent = keys.length + ' route' + (keys.length !== 1 ? 's' : '') + ' ready. Tap one to roll.';
  }

  var ARROW_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M5 2l5 5-5 5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  list.innerHTML = keys.map(function(name) {
    var route = routes[name];
    var est = route.estimate;
    var progress = getSavedProgress(name);
    var isProgress = !!progress;

    var total = route.stopCount || (route.stops ? route.stops.length : 0);
    var stopsDisplay = isProgress ? (progress.currentStopIndex + '/' + total) : total;
    var timeDisplay = est ? formatHoursShort(est.totalHours) : '—';
    var chargeDisplay = est ? ('$' + est.suggestedPrice.toFixed(0)) : '—';

    var statusHtml = isProgress
      ? '<span class="rr-route-status">● In Progress</span>'
      : '<span class="rr-route-status">Ready</span>';

    return '<button type="button" class="rr-route-card' + (isProgress ? ' is-progress' : '') + '" data-route-name="' + escapeHtml(name) + '">' +
      '<div class="rr-route-card-top">' +
        '<div class="rr-route-card-titles">' +
          statusHtml +
          '<span class="rr-route-name">' + escapeHtml(name) + '</span>' +
        '</div>' +
        '<span class="rr-route-card-cta">' + ARROW_SVG + '</span>' +
      '</div>' +
      '<div class="rr-route-stats">' +
        '<div class="rr-stat"><span class="rr-stat-label">Stops</span><span class="rr-stat-value">' + stopsDisplay + '</span></div>' +
        '<div class="rr-stat"><span class="rr-stat-label">Time</span><span class="rr-stat-value">' + timeDisplay + '</span></div>' +
        '<div class="rr-stat"><span class="rr-stat-label">Charge</span><span class="rr-stat-value' + (isProgress ? '' : ' is-accent') + '">' + chargeDisplay + '</span></div>' +
      '</div>' +
    '</button>';
  }).join('');

  list.querySelectorAll('.rr-route-card[data-route-name]').forEach(function(el) {
    el.addEventListener('click', function() {
      loadRoute(el.getAttribute('data-route-name'));
    });
  });
}

// ============================================================
// Header chrome — date chip, greeting, status-bar time
// ============================================================
function updateListHeader() {
  var greetEl = document.getElementById('rr-greeting');
  if (greetEl) greetEl.textContent = 'Hello Taylor';
}

// ============================================================
// LOAD ROUTE → Show preview screen
// ============================================================
function loadRoute(name) {
  var progress = getSavedProgress(name);
  var isResume = progress && progress.currentStopIndex < progress.stops.length;

  var route = cachedRoutes[name];
  if (!route || !route.stops || route.stops.length === 0) {
    alert('Route not found or has no stops.');
    return;
  }

  if (isResume) {
    state.stops = progress.stops;
    state.currentStopIndex = progress.currentStopIndex;
    state.deliveredCount = progress.deliveredCount;
    state.skippedCount = progress.skippedCount;
    state.routeName = name;
    state.estimate = progress.estimate || null;
    state.tripStartTime = progress.tripStartTime || Date.now();
    state.activeSeconds = progress.activeSeconds || 0;
    state.activeSince = null;  // always paused on reload — driver must tap Resume
  } else {
    state.routeName = name;
    state.stops = route.stops;
    state.currentStopIndex = 0;
    state.deliveredCount = 0;
    state.skippedCount = 0;
    state.estimate = route.estimate || null;
    state.tripStartTime = null;
    state.activeSeconds = 0;
    state.activeSince = null;
  }

  showStartScreen(isResume);
}

// ============================================================
// START SCREEN — Preview before driving
// ============================================================
function showStartScreen(isResume) {
  var total = state.stops.length;
  var remaining = total - state.currentStopIndex;
  var est = state.estimate;

  document.getElementById('start-route-name').textContent = state.routeName;
  document.getElementById('start-route-subtitle').textContent =
    total + ' stop' + (total !== 1 ? 's' : '') + ' · auto-optimized for fastest drive';

  document.getElementById('start-strip-stops').textContent = total;
  document.getElementById('start-strip-time').textContent = est ? formatHoursShort(est.totalHours) : '—';
  document.getElementById('start-strip-charge').textContent = est ? ('$' + est.suggestedPrice.toFixed(0)) : '—';

  renderStartPriceBreakdown(est, total);

  var CHECK_SVG = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6l3 3 5-6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  var stopListEl = document.getElementById('start-stop-list');
  stopListEl.innerHTML = state.stops.map(function(stop, i) {
    var done = isResume && i < state.currentStopIndex;
    var active = isResume && i === state.currentStopIndex;
    var classes = 'rr-stop-item';
    if (done) classes += ' is-done';
    if (active) classes += ' is-active';
    var avatarContent = done ? CHECK_SVG : (i + 1);
    return '<div class="' + classes + '">' +
      '<div class="rr-stop-avatar">' + avatarContent + '</div>' +
      '<div class="rr-stop-text">' +
        '<div class="rr-stop-name">' + escapeHtml(stop.name) + '</div>' +
        '<div class="rr-stop-addr">' + escapeHtml(stop.address) + '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  var resumeInfo = document.getElementById('start-resume-info');
  var goLabel = document.getElementById('start-go-label');
  if (isResume) {
    resumeInfo.hidden = false;
    document.getElementById('start-resume-text').innerHTML =
      '<strong>Resuming —</strong> ' + state.deliveredCount + ' delivered, ' + remaining + ' left';
    goLabel.textContent = 'Resume Route';
  } else {
    resumeInfo.hidden = true;
    goLabel.textContent = 'Start Route';
  }

  showScreen('start');
}

// ============================================================
// START ROUTE — Get GPS, optimize, then begin
// ============================================================
function renderStartPriceBreakdown(est, totalStops) {
  var detailsEl = document.getElementById('start-price-details');
  var rowsEl = document.getElementById('start-price-rows');
  if (!detailsEl || !rowsEl) return;

  if (!est) {
    detailsEl.style.display = 'none';
    return;
  }
  detailsEl.style.display = '';

  var rows = [
    { label: 'Driver pay · ' + formatHoursShort(est.totalHours) + ' @ $20/hr', value: '$' + est.laborCost.toFixed(2) },
    { label: 'Gas · ' + est.totalMiles.toFixed(0) + ' mi @ $0.18/mi',          value: '$' + est.gasCost.toFixed(2) },
    { label: '25% cushion (profit/overhead)',                                   value: '$' + est.cushion.toFixed(2) },
    { label: 'Total charge',                                                    value: '$' + est.suggestedPrice.toFixed(0), total: true },
    { label: 'That\'s about $' + est.perStop.toFixed(2) + ' per stop',          value: '' }
  ];

  rowsEl.innerHTML = rows.map(function(r) {
    return '<div class="rr-price-row' + (r.total ? ' is-total' : '') + '">' +
      '<span>' + escapeHtml(r.label) + '</span>' +
      (r.value ? '<span class="rr-price-value">' + r.value + '</span>' : '') +
    '</div>';
  }).join('');
}

function startRoute() {
  var btn = document.getElementById('start-go-btn');
  var label = document.getElementById('start-go-label');
  var originalText = label.textContent;
  btn.disabled = true;
  label.textContent = 'Optimizing…';

  getDriverLocation(function(driverPos) {
    if (state.tripStartTime === null && state.stops.length > 2) {
      if (driverPos) {
        state.stops = optimizeRouteFromGPS(state.stops, driverPos);
      }
    }
    state.tripStartTime = state.tripStartTime || Date.now();
    startActiveClock();
    btn.disabled = false;
    label.textContent = originalText;
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

  document.getElementById('delivery-company').textContent = stop.name;
  document.getElementById('delivery-address').textContent = stop.address;
  document.getElementById('nav-stop-num').textContent = state.currentStopIndex + 1;
  document.getElementById('nav-stop-total').textContent = total;

  var pct = total > 0 ? ((state.currentStopIndex) / total * 100) : 0;
  document.getElementById('delivery-progress-fill').style.width = pct + '%';

  document.getElementById('nav-turn-text').textContent = 'Calculating route...';
  document.getElementById('nav-turn-distance').textContent = '';
  document.getElementById('nav-turn-icon').innerHTML = getTurnIconSVG('straight');

  state.currentSteps = [];
  state.lastSpokenStep = -1;

  showScreen('nav');
  startGPSTracking();
  navigateToStop(stop);

  speak('Stop ' + (state.currentStopIndex + 1) + ' of ' + total + '. ' + stop.name + '. ' + stop.address);
}

// ============================================================
// BIG TURN-BY-TURN DISPLAY
// ============================================================
function updateTurnDisplay() {
  var steps = state.currentSteps;
  if (!steps || steps.length === 0) return;

  var nextStep = steps[0];
  if (steps.length > 1 && steps[0].maneuver.type === 'depart') {
    nextStep = steps[1];
  }

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

  var stepKey = instruction;
  if (stepKey !== state._lastSpokenInstruction) {
    state._lastSpokenInstruction = stepKey;
    if (dist < 500) {
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
      navRouteLayer = L.polyline(routeCoords, { color: '#E8A838', weight: 6, opacity: 0.95 }).addTo(navMap);

      var mins = Math.round(route.duration / 60);
      document.getElementById('delivery-eta').textContent = mins < 1 ? '<1 min' : mins + ' min';
      document.getElementById('delivery-distance').textContent = formatDistance(route.distance);

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
  stopActiveClock();
  saveProgress();

  var total = state.stops.length;
  var remaining = total - state.currentStopIndex;
  var pct = total > 0 ? (state.deliveredCount / total) : 0;

  document.getElementById('paused-done').textContent = state.deliveredCount;
  document.getElementById('paused-total').textContent = total;
  document.getElementById('paused-next-idx').textContent = Math.min(state.currentStopIndex + 1, total);

  var nextStop = state.stops[state.currentStopIndex];
  document.getElementById('paused-next-name').textContent = nextStop ? nextStop.name : 'None';
  document.getElementById('paused-remaining').textContent = remaining;

  var clockedEl = document.getElementById('paused-clocked');
  if (clockedEl) clockedEl.textContent = formatElapsed(state.activeSeconds);

  var ring = document.getElementById('paused-ring-fg');
  if (ring) {
    var C = 2 * Math.PI * 92;
    ring.setAttribute('stroke-dasharray', C.toFixed(3));
    ring.setAttribute('stroke-dashoffset', (C * (1 - pct)).toFixed(3));
  }

  speak('Trip paused.');
  showScreen('paused');
}

function resumeTrip() {
  startActiveClock();
  showDeliveryScreen();
}

function endTrip() {
  if (confirm('End trip? Progress is saved - you can resume later.')) {
    stopGPSTracking();
    stopActiveClock();
    saveProgress();
    showScreen('upload');
  }
}

function exitToRoutes() {
  stopGPSTracking();
  stopActiveClock();
  saveProgress();
  showScreen('upload');
}

// ============================================================
// TRIP COMPLETE
// ============================================================
function tripComplete() {
  stopGPSTracking();
  stopActiveClock();
  state.tripEndTime = Date.now();

  // Prefer the active (clocked-in) seconds if we tracked them;
  // fall back to wall-clock duration for legacy resumed trips.
  var actualHours = state.activeSeconds > 0
    ? state.activeSeconds / 3600
    : (state.tripStartTime ? (state.tripEndTime - state.tripStartTime) / 1000 / 3600 : 0);

  document.getElementById('complete-delivered').textContent = state.deliveredCount;
  document.getElementById('complete-skipped').textContent = state.skippedCount;
  document.getElementById('complete-route-name').textContent = state.routeName;
  document.getElementById('complete-time').textContent = formatHoursShort(actualHours);
  document.getElementById('complete-trip-id').textContent = '#' + deriveTripId(state.routeName, state.tripStartTime);

  renderTripLedger(actualHours);
  writeRunSummary();

  speak('All done! ' + state.deliveredCount + ' delivered.');
  clearProgress();
  showScreen('complete');
}

function renderTripLedger(actualHours) {
  var est = state.estimate;
  var hourlyRate = 20;
  var gasPerMile = 0.18;

  var miles = est ? est.totalMiles : 0;
  var actualLabor = actualHours * hourlyRate;
  var actualGas = miles * gasPerMile;
  var actualCost = actualLabor + actualGas;
  var charged = est ? est.suggestedPrice : 0;
  var profit = charged - actualCost;
  var nextCharge = Math.round(actualCost * 1.25);

  var profitEl = document.getElementById('complete-profit');
  profitEl.textContent = '$' + Math.round(profit);
  profitEl.classList.toggle('is-loss', profit < 0);

  document.getElementById('complete-charged').textContent = '$' + Math.round(charged);
  document.getElementById('complete-next-charge').textContent = '$' + nextCharge;

  var rows = [
    { label: 'Driver pay · ' + formatHoursShort(actualHours) + ' @ $' + hourlyRate + '/hr', value: '$' + actualLabor.toFixed(0) },
    { label: 'Gas · ' + miles.toFixed(0) + ' mi @ $' + gasPerMile.toFixed(2), value: '$' + actualGas.toFixed(2) },
    { label: 'Cost total', value: '$' + actualCost.toFixed(2), total: true }
  ];

  document.getElementById('complete-ledger-rows').innerHTML = rows.map(function(r) {
    return '<div class="rr-ledger-row' + (r.total ? ' is-total' : '') + '">' +
      '<span>' + escapeHtml(r.label) + '</span>' +
      '<span class="rr-ledger-value">' + r.value + '</span>' +
    '</div>';
  }).join('');
}

function deriveTripId(routeName, tripStartTime) {
  var letters = String(routeName || 'RR').replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase();
  if (letters.length < 2) letters = (letters + 'RR').slice(0, 2);
  var digits = String(tripStartTime || Date.now()).slice(-3);
  return letters + '-' + digits;
}

function newTrip() {
  state = {
    stops: [], currentStopIndex: 0, deliveredCount: 0, skippedCount: 0,
    userLocation: null, watchId: null, routeName: '', estimate: null,
    tripStartTime: null, tripEndTime: null,
    activeSince: null, activeSeconds: 0,
    voiceEnabled: loadVoicePref(),
    currentSteps: [], lastSpokenStep: -1, lastSpokenArrival: -1
  };
  navMap = null; navRouteLayer = null; userMarker = null; stopMarker = null;
  document.getElementById('nav-map').innerHTML = '';
  loadRoutesFromFirebase();
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
      refreshDirectionsThrottled();
    },
    function(err) { console.log('GPS:', err.message); },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
  );
}

var _lastDirectionsFetch = 0;
function refreshDirectionsThrottled() {
  var now = Date.now();
  if (now - _lastDirectionsFetch < 15000) return;
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
      radius: 10, fillColor: '#16130F', fillOpacity: 1, color: '#E8A838', weight: 3
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
// PROGRESS PERSISTENCE (localStorage only)
// ============================================================
function getProgressKey(name) { return 'rr_progress_' + (name || state.routeName); }

function saveProgress() {
  // Persist the clock with any in-flight chunk already rolled in — mirrors
  // stopActiveClock() but non-destructively, so the in-memory clock keeps
  // ticking if the trip is still active.
  var persistSeconds = state.activeSeconds || 0;
  if (state.activeSince !== null) {
    persistSeconds += (Date.now() - state.activeSince) / 1000;
  }
  var data = {
    stops: state.stops,
    currentStopIndex: state.currentStopIndex,
    deliveredCount: state.deliveredCount,
    skippedCount: state.skippedCount,
    routeName: state.routeName,
    estimate: state.estimate,
    tripStartTime: state.tripStartTime,
    activeSeconds: persistSeconds,
    savedAt: Date.now()
  };
  try { localStorage.setItem(getProgressKey(), JSON.stringify(data)); } catch (e) {}
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
}

// ============================================================
// COMPLETED RUN HISTORY
// ============================================================
function writeRunSummary() {
  if (!state.routeName || !state.tripStartTime) return;
  var est = state.estimate || {};
  var payload = {
    routeName: state.routeName,
    startedAt: state.tripStartTime,
    endedAt: state.tripEndTime || Date.now(),
    activeSeconds: Math.round(state.activeSeconds || 0),
    clockSeconds: Math.round(((state.tripEndTime || Date.now()) - state.tripStartTime) / 1000),
    stopCount: state.stops.length,
    deliveredCount: state.deliveredCount,
    skippedCount: state.skippedCount,
    estimatedMiles: est.totalMiles || 0,
    estimatedHours: est.totalHours || 0,
    suggestedPrice: est.suggestedPrice || 0,
    tripId: deriveTripId(state.routeName, state.tripStartTime)
  };
  try {
    db.collection('routes').doc(state.routeName).collection('runs').add(payload)
      .then(function() { _historyCache = null; })
      .catch(function(err) { console.warn('Could not write run summary:', err); });
  } catch (err) {
    console.warn('Could not write run summary:', err);
  }
}

var _historyCache = null;

function showHistoryScreen() {
  var listEl = document.getElementById('history-list');
  var countEl = document.getElementById('history-count');
  var emptyEl = document.getElementById('history-empty');
  if (listEl) listEl.innerHTML = '';
  if (countEl) countEl.textContent = '— total';
  if (emptyEl) emptyEl.hidden = true;
  showScreen('history');

  if (_historyCache) {
    renderHistoryList(_historyCache);
    return;
  }

  var loadingEl = document.getElementById('history-loading');
  if (loadingEl) loadingEl.hidden = false;

  db.collectionGroup('runs').get().then(function(snap) {
    var runs = snap.docs.map(function(d) { return d.data(); });
    runs.sort(function(a, b) { return (b.endedAt || 0) - (a.endedAt || 0); });
    _historyCache = runs;
    if (loadingEl) loadingEl.hidden = true;
    renderHistoryList(runs);
  }).catch(function(err) {
    console.error('history load failed:', err);
    if (loadingEl) loadingEl.hidden = true;
    if (emptyEl) {
      emptyEl.hidden = false;
      emptyEl.textContent = 'Could not load history. Check your connection and try again.';
    }
  });
}

function renderHistoryList(runs) {
  var listEl = document.getElementById('history-list');
  var countEl = document.getElementById('history-count');
  var emptyEl = document.getElementById('history-empty');
  if (!listEl) return;

  countEl.textContent = runs.length + ' total';

  if (runs.length === 0) {
    listEl.innerHTML = '';
    emptyEl.hidden = false;
    emptyEl.textContent = "No runs yet. Complete a route and it'll show up here.";
    return;
  }
  emptyEl.hidden = true;

  listEl.innerHTML = runs.map(function(r) {
    var when = formatRunWhen(r.endedAt);
    var actualSecs = r.activeSeconds || 0;
    var estSecs = (r.estimatedHours || 0) * 3600;
    var varianceHtml = buildVariancePill(actualSecs, estSecs);

    var statsLine = r.deliveredCount + ' delivered · ' +
      (r.skippedCount || 0) + ' skipped · ' +
      (r.estimatedMiles ? Math.round(r.estimatedMiles) + ' mi · ' : '') +
      '$' + Math.round(r.suggestedPrice || 0) +
      (r.tripId ? ' · #' + r.tripId : '');

    return '<div class="rr-history-row">' +
      '<div class="rr-history-row-head">' +
        '<span class="rr-history-row-name">' + escapeHtml(r.routeName || '—') + '</span>' +
        '<span class="rr-history-row-when rr-mono">' + when + '</span>' +
      '</div>' +
      '<div class="rr-history-row-times">' +
        '<div class="rr-history-time">' +
          '<span class="rr-history-time-label">Actual</span>' +
          '<span class="rr-history-time-value">' + formatElapsed(actualSecs) + '</span>' +
        '</div>' +
        '<div class="rr-history-time">' +
          '<span class="rr-history-time-label">Est</span>' +
          '<span class="rr-history-time-value rr-history-time-est">' + formatElapsed(estSecs) + '</span>' +
        '</div>' +
        varianceHtml +
      '</div>' +
      '<div class="rr-history-stats rr-mono">' + escapeHtml(statsLine) + '</div>' +
    '</div>';
  }).join('');
}

function buildVariancePill(actualSecs, estSecs) {
  if (!estSecs) return '';
  var delta = actualSecs - estSecs;
  var absMin = Math.abs(Math.round(delta / 60));
  var tolerance = Math.max(estSecs * 0.05, 180);  // 5% or 3min, whichever is larger
  var variant, label;
  if (Math.abs(delta) <= tolerance) {
    variant = 'ontrack';
    label = 'On target';
  } else if (delta < 0) {
    variant = 'under';
    label = absMin + 'm under';
  } else {
    variant = 'over';
    label = absMin + 'm over';
  }
  return '<span class="rr-history-variance is-' + variant + '">' + label + '</span>';
}

function formatRunWhen(ms) {
  if (!ms) return '—';
  var d = new Date(ms);
  var days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
  var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var h = d.getHours();
  var ampm = h >= 12 ? 'PM' : 'AM';
  var hr12 = h % 12 || 12;
  var mm = d.getMinutes();
  return days[d.getDay()] + ' · ' + months[d.getMonth()] + ' ' + d.getDate() +
    ', ' + hr12 + ':' + (mm < 10 ? '0' + mm : mm) + ' ' + ampm;
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

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', function() {
  updateListHeader();
  syncVoiceUI();
  loadRoutesFromFirebase();
});
