/* ═══════════════════════════════════════════════
   AgroSense – app.js
   Dashboard logic: charts, pump control, live data
═══════════════════════════════════════════════ */

/* ── Sensor state ─────────────────────────────── */
const state = {
  moisture:    38.4,
  temperature: 27.2,
  humidity:    65.2,
  pumpOn:      true,
  dataLogged:  276,
  cropActive:  'Tomato',
  pumpCycles:  0,
  waterUsedML: 0,
  lastWateredSecs: 0,
  pumpSeconds: 0,   // counts up while pump is ON
};

/* ── Chart colours ────────────────────────────── */
const C_GREEN_MID    = '#3b6d11';
const C_GREEN_ACCENT = '#97c459';
const C_GREEN_FILL   = 'rgba(59,109,17,0.08)';
const C_ORANGE       = '#ba7517';
const C_GRID         = 'rgba(0,0,0,0.05)';
const C_TICK         = '#7a9178';

/* ── Crop profiles ────────────────────────────── */
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
  if (v < 30)  return ['DRY — Approaching Management Allowed Depletion', 'badge-dry'];
  if (v > 70)  return ['ANOXIA RISK — Soil Saturation Dangerously High', 'badge-anoxia'];
  return               ['OPTIMAL — Soil Moisture Within Safe Range',      'badge-optimal'];
}

/* ── Refresh all cards ────────────────────────── */
function refreshCards() {
  // Soil moisture
  el('soilMoisture').textContent = state.moisture.toFixed(1) + '%';
  const [bTxt, bCls] = moistureBadge(state.moisture);
  el('moistureBadge').textContent = bTxt;
  el('moistureBadge').className   = 'stat-badge ' + bCls;

  // Temperature gauge
  el('gaugeTempVal').textContent = state.temperature.toFixed(1);
  setArc('tempArc', tempFraction(state.temperature));
  const [tLabel, tCls] = tempStatus(state.temperature);
  el('tempStatus').textContent  = tLabel;
  el('tempStatus').className    = 'gauge-tile-status ' + tCls;

  // Humidity gauge
  el('gaugeHumVal').textContent = state.humidity.toFixed(1);
  setArc('humArc', humFraction(state.humidity));
  const [hLabel, hCls] = humStatus(state.humidity);
  el('humStatus').textContent = hLabel;
  el('humStatus').className   = 'gauge-tile-status ' + hCls;

  // Pump card
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

  el('pumpRuntime').textContent = fmtTime(state.pumpSeconds);
  el('pumpCycles').textContent  = state.pumpCycles;
  el('dataLogged').textContent  = state.dataLogged.toLocaleString() + ' Entries';

  // Actuation panel info pills
  const lw = el('lastWatered');
  const wu = el('waterUsed');
  if (lw) lw.textContent = state.lastWateredSecs === 0 ? 'Just now' : fmtAgo(state.lastWateredSecs);
  if (wu) wu.textContent = state.waterUsedML + ' mL';
}

/* ── Pump controls ────────────────────────────── */
function togglePump() {
  const wasOn = state.pumpOn;
  state.pumpOn = !wasOn;
  if (!wasOn) state.pumpCycles++;   // count turning ON as a cycle
  refreshCards();
}

function togglePumpSwitch() {
  const wasOn = state.pumpOn;
  state.pumpOn = el('pumpToggleSwitch').checked;
  if (!wasOn && state.pumpOn) state.pumpCycles++;
  refreshCards();
}

function manualWater() {
  if (!state.pumpOn) state.pumpCycles++;
  state.pumpOn = true;
  state.lastWateredSecs = 0;
  state.waterUsedML += 200;
  refreshCards();
  const btn  = el('btnManualWater');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="bi bi-check2 me-1"></i>Watering…';
  btn.style.background = '#c0dd97';
  setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; }, 2500);
}

/* ── Crop profile ─────────────────────────────── */
function renderCrop(name) {
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
  renderCrop(name);
}

/* ── Mock time-series ─────────────────────────── */
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

/* ── Line chart ───────────────────────────────── */
let lineChart;
function buildLineChart(hours = 24) {
  const ctx = el('moistureLineChart').getContext('2d');
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
        { label: 'Optimal', data: Array(n).fill(40), borderColor: C_GREEN_MID, borderWidth: 1.5,
          borderDash: [6,4], pointRadius: 0, fill: false },
        { label: 'Low threshold', data: Array(n).fill(20), borderColor: C_ORANGE, borderWidth: 1.5,
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

/* ── Bar chart ────────────────────────────────── */
function buildBarChart() {
  const ctx     = el('historyBarChart').getContext('2d');
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

function updateRange(hours) { buildLineChart(Number(hours)); }

/* ── Pump runtime ticker ──────────────────────── */
function startRuntimeTicker() {
  setInterval(() => {
    if (state.pumpOn) {
      state.pumpSeconds++;
      el('pumpRuntime').textContent = fmtTime(state.pumpSeconds);
    }
  }, 1000);
}

/* ── Simulate live sensor data ────────────────── */
function simulateLiveData() {
  setInterval(() => {
    state.moisture    = Math.min(100, Math.max(5,  state.moisture    + (Math.random() * 4 - 2)));
    state.temperature = Math.min(45,  Math.max(15, state.temperature + (Math.random() * 1 - 0.5)));
    state.humidity    = Math.min(100, Math.max(20, state.humidity    + (Math.random() * 2 - 1)));
    state.dataLogged += 1;
    state.lastWateredSecs += 3;
    if (state.pumpOn) state.waterUsedML += Math.floor(Math.random() * 15 + 5);

    // Auto pump logic
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

/* ── Init ─────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  refreshCards();
  renderCrop('Tomato');
  buildLineChart(24);
  buildBarChart();
  startRuntimeTicker();
  simulateLiveData();
});