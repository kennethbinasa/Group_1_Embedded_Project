/* ═══════════════════════════════════════════════
   AgroSense – app.js
   Dashboard logic: charts, pump control, live data

   BACKEND INTEGRATION OVERVIEW
   ─────────────────────────────────────────────────
   Currently all data in this file is SIMULATED.
   To connect a real backend, you need to:

   1. SENSOR DATA (moisture, temperature, humidity)
      Replace simulateLiveData() with either:
      a) Polling: setInterval(() => fetchSensorData(), 3000)
         GET /api/sensors/latest  → { moisture, temperature, humidity }
      b) WebSocket (recommended for real-time):
         const ws = new WebSocket('ws://your-pi-ip/ws')
         ws.onmessage = (e) => { updateState(JSON.parse(e.data)); }

   2. PUMP CONTROL
      Replace togglePump() / manualWater() with fetch() calls:
      POST /api/pump/toggle  { "state": true/false }
      POST /api/pump/manual  { "duration_minutes": 30 }

   3. SETTINGS PERSISTENCE
      Slider values (pulse, PWM, threshold) should be saved to DB.
      On load: GET /api/settings  → restore all slider positions.
      On change: POST /api/settings  { key: value }

   4. HISTORICAL DATA
      Replace genMoistureData() with:
      GET /api/sensors/moisture/history?hours=24
      GET /api/sensors/moisture/weekly-average

   Recommended backend stack: Node.js (Express) or Python (Flask/FastAPI)
   running on a Raspberry Pi, with SQLite or PostgreSQL as the database,
   and MQTT or WebSocket for real-time sensor push from microcontrollers.
═══════════════════════════════════════════════ */


/* ── Sensor state ─────────────────────────────────────────────────────
   BACKEND: This object holds the current frontend state.
   On page load (DOMContentLoaded below), replace the hardcoded initial
   values by fetching from GET /api/sensors/latest and GET /api/settings.
   Example:
     const res = await fetch('/api/sensors/latest');
     const live = await res.json();
     state.moisture    = live.moisture;
     state.temperature = live.temperature;
     state.humidity    = live.humidity;
     state.pumpOn      = live.pump_state;
     state.dataLogged  = live.data_logged;
──────────────────────────────────────────────────────────────────────── */
const state = {
  moisture:    38.4,      // BACKEND: from sensor, GET /api/sensors/latest
  temperature: 27.2,      // BACKEND: from sensor, GET /api/sensors/latest
  humidity:    65.2,      // BACKEND: from sensor, GET /api/sensors/latest
  pumpOn:      true,      // BACKEND: from relay state, GET /api/pump/status
  dataLogged:  276,       // BACKEND: from DB count, GET /api/stats/data-logged
  cropActive:  'Tomato',  // BACKEND: persisted setting, GET /api/settings/crop
  pumpCycles:  0,         // BACKEND: from DB (today's cycle count), GET /api/pump/cycles
  waterUsedML: 0,         // BACKEND: from flow meter sensor, GET /api/sensors/flow
  lastWateredSecs: 0,     // BACKEND: computed from last watered timestamp in DB
  pumpSeconds: 0,         // BACKEND: cumulative runtime from DB, GET /api/pump/runtime
};


/* ── Chart colours ────────────────────────────── */
const C_GREEN_MID    = '#3b6d11';
const C_GREEN_ACCENT = '#97c459';
const C_GREEN_FILL   = 'rgba(59,109,17,0.08)';
const C_ORANGE       = '#ba7517';
const C_GRID         = 'rgba(0,0,0,0.05)';
const C_TICK         = '#7a9178';


/* ── Crop profiles ────────────────────────────────────────────────────
   BACKEND: This hardcoded object should be replaced with data fetched
   from your backend so new crops can be added without touching this file.
   GET /api/crops  → returns:
   {
     "Tomato": [["Daily VW demand","600–1,200 mL"], ...],
     "Pechay":  [["Daily VW demand","150–300 mL"],  ...]
   }
   Then: const CROPS = await fetch('/api/crops').then(r => r.json());
──────────────────────────────────────────────────────────────────────── */
const CROPS = {
  Tomato: [
    ['Daily VW demand', '600–1,200 mL'],
    ['FAO-56 Kc (mid)',  '1.15'],
    ['Kc (late)',        '0.70'],
    ['Root depth',       '60–150 cm'],
    ['MAD threshold',    '40%'],
  ],
  Pechay: [
    ['Daily VW demand', '150–300 mL'],
    ['FAO-56 Kc (mid)',  '0.95'],
    ['Kc (late)',        '0.85'],
    ['Root depth',       '15–30 cm'],
    ['MAD threshold',    '35%'],
  ],
};


/* ── Helpers ──────────────────────────────────── */
function el(id) { return document.getElementById(id); }

function fmtAgo(secs) {
  if (secs < 60)  return secs + 's ago';
  if (secs < 3600) return Math.floor(secs/60) + 'm ago';
  return Math.floor(secs/3600) + 'h ago';
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60), s = secs % 60;
  return m + ':' + String(s).padStart(2, '0');
}


/* ── Gauge arc update ─────────────────────────── */
// Arc path length is 195. offset = 195 - (195 * fraction)
function setArc(arcId, fraction) {
  const arc = el(arcId);
  if (!arc) return;
  const offset = 195 - 195 * Math.min(1, Math.max(0, fraction));
  arc.setAttribute('stroke-dashoffset', offset.toFixed(1));
}

function tempFraction(t)  { return (t - 15) / (45 - 15); }   // range 15–45 °C
function humFraction(h)   { return h / 100; }                  // range 0–100 %

function tempStatus(t) {
  if (t < 18) return ['Cool',     'status-cool'];
  if (t < 24) return ['Mild',     'status-moderate'];
  if (t < 30) return ['Warm',     'status-warm'];
  return              ['Hot',     'status-hot'];
}
function humStatus(h) {
  if (h < 30) return ['Dry',      'status-dry-air'];
  if (h < 60) return ['Moderate', 'status-moderate'];
  return              ['Humid',   'status-humid'];
}


/* ── Moisture badge ───────────────────────────── */
function moistureBadge(v) {
  /* BACKEND: This same threshold logic should also live on your backend
     so the microcontroller/server can make irrigation decisions even
     when the browser is not open. Mirror this in Python/Node. */
  if (v < 30)  return ['DRY — Approaching Management Allowed Depletion', 'badge-dry'];
  if (v > 70)  return ['ANOXIA RISK — Soil Saturation Dangerously High', 'badge-anoxia'];
  return               ['OPTIMAL — Soil Moisture Within Safe Range',      'badge-optimal'];
}


/* ── Refresh all cards ────────────────────────────────────────────────
   BACKEND: This function is the central UI updater.
   Call it after every API response or WebSocket message that delivers
   new sensor readings. Replace the state object properties with the
   values from your API payload before calling refreshCards().
──────────────────────────────────────────────────────────────────────── */
function refreshCards() {
  // Soil moisture
  /* BACKEND: state.moisture should be the latest value from
     GET /api/sensors/latest or a WebSocket push */
  el('soilMoisture').textContent = state.moisture.toFixed(1) + '%';
  const [bTxt, bCls] = moistureBadge(state.moisture);
  el('moistureBadge').textContent = bTxt;
  el('moistureBadge').className   = 'stat-badge ' + bCls;

  // Temperature gauge
  /* BACKEND: state.temperature from GET /api/sensors/latest */
  el('gaugeTempVal').textContent = state.temperature.toFixed(1);
  setArc('tempArc', tempFraction(state.temperature));
  const [tLabel, tCls] = tempStatus(state.temperature);
  el('tempStatus').textContent  = tLabel;
  el('tempStatus').className    = 'gauge-tile-status ' + tCls;

  // Humidity gauge
  /* BACKEND: state.humidity from GET /api/sensors/latest */
  el('gaugeHumVal').textContent = state.humidity.toFixed(1);
  setArc('humArc', humFraction(state.humidity));
  const [hLabel, hCls] = humStatus(state.humidity);
  el('humStatus').textContent = hLabel;
  el('humStatus').className   = 'gauge-tile-status ' + hCls;

  // Pump card
  /* BACKEND: state.pumpOn reflects the actual relay state.
     Should be updated from GET /api/pump/status response,
     or pushed via WebSocket when the relay changes state on the device. */
  const ring   = el('pumpRing');
  const icon   = el('pumpIcon');
  const badge  = el('pumpBadge');
  const toggle = el('pumpToggleSwitch');
  const lbl    = el('toggleLabel');

  if (state.pumpOn) {
    ring.className  = 'pump-ring ring-on';
    icon.className  = 'bi bi-power pump-icon-big pump-on-color';
    badge.textContent = 'Pump: ON';
    badge.className   = 'stat-badge badge-on';
    if (toggle) toggle.checked = true;
    if (lbl)  { lbl.textContent = 'ON';  lbl.style.color = '#3b6d11'; }
  } else {
    ring.className  = 'pump-ring ring-off';
    icon.className  = 'bi bi-power pump-icon-big pump-off-color';
    badge.textContent = 'Pump: OFF';
    badge.className   = 'stat-badge badge-off';
    if (toggle) toggle.checked = false;
    if (lbl)  { lbl.textContent = 'OFF'; lbl.style.color = '#a32d2d'; }
  }

  /* BACKEND: state.pumpSeconds should be fetched from DB on load
     (GET /api/pump/runtime) so it persists across browser refreshes.
     The ticker below only counts up while the page is open. */
  el('pumpRuntime').textContent = fmtTime(state.pumpSeconds);

  /* BACKEND: state.pumpCycles from GET /api/pump/cycles (today's count) */
  el('pumpCycles').textContent  = state.pumpCycles;

  /* BACKEND: state.dataLogged from GET /api/stats/data-logged */
  el('dataLogged').textContent  = state.dataLogged.toLocaleString() + ' Entries';

  // Actuation panel info pills
  const lw = el('lastWatered');
  const wu = el('waterUsed');
  /* BACKEND: lastWateredSecs computed from ISO timestamp in DB.
     On load: fetch last_watered timestamp, compute seconds ago, store in state.
     GET /api/pump/last-watered → { "timestamp": "2025-05-24T10:30:00Z" }
     waterUsedML from flow meter sensor cumulative total. */
  if (lw) lw.textContent = state.lastWateredSecs === 0 ? 'Just now' : fmtAgo(state.lastWateredSecs);
  if (wu) wu.textContent = state.waterUsedML + ' mL';
}


/* ── Pump controls ────────────────────────────────────────────────────
   BACKEND: Both functions below need to send HTTP requests to your
   backend API to actually toggle the physical pump relay.
──────────────────────────────────────────────────────────────────────── */
function togglePump() {
  const wasOn = state.pumpOn;
  state.pumpOn = !wasOn;
  if (!wasOn) state.pumpCycles++;

  /* BACKEND: Send relay command to server.
     Replace the line below with:
     fetch('/api/pump/toggle', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ state: state.pumpOn })
     }).catch(err => console.error('Pump toggle failed:', err));
  */

  refreshCards();
}

function togglePumpSwitch() {
  const wasOn = state.pumpOn;
  state.pumpOn = el('pumpToggleSwitch').checked;
  if (!wasOn && state.pumpOn) state.pumpCycles++;

  /* BACKEND: Same as togglePump() — send the new state to the relay API.
     fetch('/api/pump/toggle', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ state: state.pumpOn })
     });
  */

  refreshCards();
}

function manualWater() {
  if (!state.pumpOn) state.pumpCycles++;
  state.pumpOn = true;
  state.lastWateredSecs = 0;
  state.waterUsedML += 200;  // BACKEND: remove this — use real flow meter data

  /* BACKEND: Trigger a timed irrigation cycle on the server.
     The duration should be read from the pulse duration slider.
     const duration = document.querySelector('input.agro-range').value;
     fetch('/api/pump/manual', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ duration_minutes: Number(duration) })
     }).then(res => res.json())
       .then(data => {
         // Optionally update waterUsedML from the server response
         state.waterUsedML = data.total_water_ml;
         refreshCards();
       })
       .catch(err => console.error('Manual water failed:', err));
  */

  refreshCards();
  const btn  = el('btnManualWater');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="bi bi-check2 me-1"></i>Watering…';
  btn.style.background = '#c0dd97';
  setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; }, 2500);
}


/* ── Crop profile ─────────────────────────────── */
function renderCrop(name) {
  /* BACKEND: CROPS[name] is currently hardcoded above.
     Replace with data fetched from GET /api/crops/:name
     to allow dynamic crop management from the backend. */
  el('cropParams').innerHTML = CROPS[name].map(([k, v]) =>
    `<div class="param-row">
      <span class="param-key">${k}</span>
      <span class="param-val">${v}</span>
    </div>`
  ).join('');
}

function selectCrop(name) {
  state.cropActive = name;
  ['Tomato', 'Pechay'].forEach(c => {
    el('tab' + c).classList.toggle('active', c === name);
  });

  /* BACKEND: Persist the selected crop so it restores after page reload.
     fetch('/api/settings/crop', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ crop: name })
     });
  */

  renderCrop(name);
}


/* ── Mock time-series data ────────────────────────────────────────────
   BACKEND: This entire function should be replaced with a real API call.
   GET /api/sensors/moisture/history?hours=24
   Expected response:
   {
     "labels": ["08:00", "09:00", ...],
     "data":   [42.1, 38.7, ...]
   }
   Then pass response directly to buildLineChart() instead of this generator.
──────────────────────────────────────────────────────────────────────── */
function genMoistureData(hours) {
  const labels = [], data = [];
  const now = new Date();
  const step = Math.max(1, Math.floor(hours / 10));
  for (let i = hours; i >= 0; i -= step) {
    const t = new Date(now - i * 3_600_000);
    labels.push(t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    data.push(+(20 + 40 * Math.abs(Math.sin(i * 0.4 + 1)) + Math.random() * 8).toFixed(1));
  }
  return { labels, data };
}


/* ── Line chart ───────────────────────────────────────────────────────
   BACKEND: buildLineChart() currently calls genMoistureData() for fake data.
   Replace with:
   async function buildLineChart(hours = 24) {
     const res = await fetch(`/api/sensors/moisture/history?hours=${hours}`);
     const { labels, data } = await res.json();
     // ...rest of chart build using real labels and data
   }
──────────────────────────────────────────────────────────────────────── */
let lineChart;
function buildLineChart(hours = 24) {
  const ctx = el('moistureLineChart').getContext('2d');
  /* BACKEND: Replace genMoistureData(hours) with real API fetch:
     const { labels, data } = await fetch(`/api/sensors/moisture/history?hours=${hours}`)
       .then(r => r.json()); */
  const { labels, data } = genMoistureData(hours);
  const n = labels.length;
  if (lineChart) lineChart.destroy();
  lineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Soil moisture (%)', data, borderColor: C_GREEN_MID, backgroundColor: C_GREEN_FILL,
          borderWidth: 2, pointRadius: 3, pointBackgroundColor: C_GREEN_MID, fill: true, tension: 0.4 },
        { label: 'Optimal',
          /* BACKEND: Replace hardcoded 40 with the current moisture threshold
             from state or from GET /api/settings */
          data: Array(n).fill(40), borderColor: C_GREEN_MID, borderWidth: 1.5,
          borderDash: [6,4], pointRadius: 0, fill: false },
        { label: 'Low threshold',
          /* BACKEND: Replace hardcoded 20 with configurable low threshold
             from GET /api/settings */
          data: Array(n).fill(20), borderColor: C_ORANGE, borderWidth: 1.5,
          borderDash: [4,4], pointRadius: 0, fill: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => c.dataset.label + ': ' + c.parsed.y + '%' } },
      },
      scales: {
        x: { ticks: { color: C_TICK, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 9 }, grid: { color: C_GRID } },
        y: {
          min: 0, max: 80,
          title: { display: true, text: 'Moisture (%)', color: C_TICK, font: { size: 9 } },
          ticks: { color: C_TICK, font: { size: 9 }, callback: v => v, maxTicksLimit: 6 },
          grid: { color: C_GRID }
        },
      },
    },
  });
}


/* ── Bar chart ────────────────────────────────────────────────────────
   BACKEND: avgData[] is hardcoded. Replace with real weekly averages:
   GET /api/sensors/moisture/weekly-average
   Expected response: { "days": ["Mon",...], "averages": [45, 55, ...] }
   Then build the chart from that response instead.
──────────────────────────────────────────────────────────────────────── */
function buildBarChart() {
  const ctx     = el('historyBarChart').getContext('2d');
  /* BACKEND: Replace these two hardcoded arrays with real DB data:
     const { days, averages } = await fetch('/api/sensors/moisture/weekly-average')
       .then(r => r.json()); */
  const days    = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const avgData = [45, 55, 38, 62, 50, 47, 53];
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{ label: 'Avg moisture (%)', data: avgData,
        backgroundColor: days.map((_, i) => i % 2 === 0 ? C_GREEN_ACCENT : C_GREEN_MID),
        borderRadius: 5, borderSkipped: false }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => c.parsed.y + '%' } },
      },
      scales: {
        x: { ticks: { color: C_TICK, font: { size: 10 } }, grid: { display: false } },
        y: { min: 0, max: 80, ticks: { color: C_TICK, font: { size: 9 }, callback: v => v, maxTicksLimit: 6 }, grid: { color: C_GRID } },
      },
    },
    plugins: [{
      id: 'barLabels',
      afterDatasetsDraw(chart) {
        const { ctx, data } = chart;
        ctx.save();
        ctx.font = '600 11px DM Sans,sans-serif';
        ctx.fillStyle = C_GREEN_MID;
        ctx.textAlign = 'center';
        chart.getDatasetMeta(0).data.forEach((bar, i) => {
          ctx.fillText(data.datasets[0].data[i] + '%', bar.x, bar.y - 5);
        });
        ctx.restore();
      },
    }],
  });
}

/* BACKEND: updateRange() is called by the chart time-range selector.
   When connected to the backend, this should re-fetch historical data
   with the new time window instead of regenerating mock data. */
function updateRange(hours) { buildLineChart(Number(hours)); }


/* ── Pump runtime ticker ──────────────────────────────────────────────
   BACKEND: This ticker only counts up while the browser tab is open.
   For persistent runtime tracking, the server/microcontroller should
   track total ON-time in the database. On page load, fetch the saved
   runtime: GET /api/pump/runtime → { "seconds": 3742 }
   Then set state.pumpSeconds = 3742 before starting this ticker.
──────────────────────────────────────────────────────────────────────── */
function startRuntimeTicker() {
  setInterval(() => {
    if (state.pumpOn) {
      state.pumpSeconds++;
      el('pumpRuntime').textContent = fmtTime(state.pumpSeconds);
    }
  }, 1000);
}


/* ── Simulate live sensor data ────────────────────────────────────────
   BACKEND: THIS ENTIRE FUNCTION SHOULD BE REMOVED when connected to
   a real backend. It only exists to simulate sensor readings in the
   absence of real hardware.

   Replace with one of these real-data strategies:

   OPTION A — HTTP Polling (simpler, slight delay):
   ─────────────────────────────────────────────────
   function startPolling() {
     setInterval(async () => {
       const res  = await fetch('/api/sensors/latest');
       const live = await res.json();
       state.moisture    = live.moisture;
       state.temperature = live.temperature;
       state.humidity    = live.humidity;
       state.pumpOn      = live.pump_on;
       state.dataLogged  = live.data_logged;
       state.waterUsedML = live.water_used_ml;
       state.lastWateredSecs = live.last_watered_secs;
       refreshCards();
     }, 3000);
   }

   OPTION B — WebSocket (real-time, recommended for this use case):
   ─────────────────────────────────────────────────────────────────
   function connectWebSocket() {
     const ws = new WebSocket('ws://your-pi-ip:8080/ws');
     ws.onmessage = (event) => {
       const live = JSON.parse(event.data);
       state.moisture    = live.moisture;
       state.temperature = live.temperature;
       state.humidity    = live.humidity;
       state.pumpOn      = live.pump_on;
       state.dataLogged  = live.data_logged;
       state.waterUsedML = live.water_used_ml;
       state.lastWateredSecs = live.last_watered_secs;
       refreshCards();
     };
     ws.onclose = () => setTimeout(connectWebSocket, 3000); // auto-reconnect
   }
──────────────────────────────────────────────────────────────────────── */
function simulateLiveData() {
  setInterval(() => {
    // BACKEND: Remove all lines below — these are fake sensor updates
    state.moisture    = Math.min(100, Math.max(5,  state.moisture    + (Math.random() * 4 - 2)));
    state.temperature = Math.min(45,  Math.max(15, state.temperature + (Math.random() * 1 - 0.5)));
    state.humidity    = Math.min(100, Math.max(20, state.humidity    + (Math.random() * 2 - 1)));
    state.dataLogged += 1;
    state.lastWateredSecs += 3;
    if (state.pumpOn) state.waterUsedML += Math.floor(Math.random() * 15 + 5);

    /* BACKEND: Auto pump logic below should live on the microcontroller
       or server side so irrigation works even without an open browser.
       Move this threshold check to your backend (Python/Node) and have
       it directly control the GPIO relay pin. The moisture threshold
       values (25 / 65) should be read from GET /api/settings, not hardcoded. */
    const wasOn = state.pumpOn;
    if (state.moisture < 25) state.pumpOn = true;
    if (state.moisture > 65) state.pumpOn = false;
    if (!wasOn && state.pumpOn) state.pumpCycles++;

    state.moisture    = +state.moisture.toFixed(1);
    state.temperature = +state.temperature.toFixed(1);
    state.humidity    = +state.humidity.toFixed(1);

    refreshCards();
  }, 3000);
}


/* ── Init ─────────────────────────────────────────────────────────────
   BACKEND: On DOMContentLoaded, before calling refreshCards(), you should:
   1. Fetch current sensor readings:  GET /api/sensors/latest
   2. Fetch saved settings:           GET /api/settings
   3. Fetch pump runtime:             GET /api/pump/runtime
   4. Fetch today's pump cycles:      GET /api/pump/cycles
   5. Fetch last watered timestamp:   GET /api/pump/last-watered
   6. Fetch crop list:                GET /api/crops  (to populate CROPS)
   7. Fetch historical chart data:    GET /api/sensors/moisture/history?hours=24
   8. Fetch weekly bar chart data:    GET /api/sensors/moisture/weekly-average
   Then call refreshCards(), renderCrop(), buildLineChart(), buildBarChart().
   After init, call connectWebSocket() (or startPolling()) instead of simulateLiveData().
──────────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  refreshCards();
  renderCrop('Tomato');
  buildLineChart(24);
  buildBarChart();
  startRuntimeTicker();
  simulateLiveData(); // BACKEND: Replace this with connectWebSocket() or startPolling()
});