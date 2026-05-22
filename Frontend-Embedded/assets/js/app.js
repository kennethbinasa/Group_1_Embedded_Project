/* ═══════════════════════════════════════════════
   AgroSense – app.js  (Light Theme)
   Dashboard logic: charts, pump control, crop profile, live data
═══════════════════════════════════════════════ */

/* ── Simulated sensor state ───────────────────── */
const state = {
  moisture:    38.4,
  temperature: 27.2,
  humidity:    65.2,
  pumpOn:      true,
  dataLogged:  276,
  cropActive:  'Tomato',
};

/* ── Chart colour palette (light theme) ──────── */
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

function moistureBadgeClass(v) {
  if (v < 30)  return ['DRY — Approaching Management Allowed Depletion', 'badge-dry'];
  if (v > 70)  return ['ANOXIA RISK — Soil Saturation Dangerously High', 'badge-anoxia'];
  return ['OPTIMAL — Soil Moisture Within Safe Range', 'badge-optimal'];
}

function refreshCards() {
  // Soil moisture
  el('soilMoisture').textContent = state.moisture.toFixed(1) + '%';
  const [bText, bClass] = moistureBadgeClass(state.moisture);
  const badge = el('moistureBadge');
  badge.textContent = bText;
  badge.className   = 'stat-badge ' + bClass;

  // Temperature & humidity
  el('temperature').textContent = state.temperature.toFixed(1) + '°C';
  el('humidity').textContent    = state.humidity.toFixed(1) + '%';

  // Update env gauge SVG text
  const gTemp = el('gaugeTempVal');
  const gHum  = el('gaugeHumVal');
  if (gTemp) gTemp.textContent = state.temperature.toFixed(1);
  if (gHum)  gHum.textContent  = state.humidity.toFixed(1);

  // Pump
  const icon  = el('pumpIcon');
  const pBadge = el('pumpBadge');
  const toggleSwitch = el('pumpToggleSwitch');
  const toggleLbl    = el('toggleLabel');

  if (state.pumpOn) {
    icon.className        = 'bi bi-power pump-on-anim';
    pBadge.textContent    = 'Pump: ON';
    pBadge.className      = 'stat-badge badge-on';
    if (toggleSwitch) toggleSwitch.checked = true;
    if (toggleLbl) { toggleLbl.textContent = 'ON'; toggleLbl.style.color = '#3b6d11'; }
  } else {
    icon.className        = 'bi bi-power';
    pBadge.textContent    = 'Pump: OFF';
    pBadge.className      = 'stat-badge badge-off';
    if (toggleSwitch) toggleSwitch.checked = false;
    if (toggleLbl) { toggleLbl.textContent = 'OFF'; toggleLbl.style.color = '#a32d2d'; }
  }

  // Data counter
  el('dataLogged').textContent = state.dataLogged.toLocaleString() + ' Entries';
}

/* ── Pump controls ────────────────────────────── */
function togglePump() {
  state.pumpOn = !state.pumpOn;
  refreshCards();
}

function togglePumpSwitch() {
  state.pumpOn = el('pumpToggleSwitch').checked;
  refreshCards();
}

function manualWater() {
  state.pumpOn = true;
  refreshCards();
  const btn = el('btnManualWater');
  const orig = btn.innerHTML;
  btn.innerHTML = '<i class="bi bi-check2 me-1"></i>Watering…';
  btn.style.background = '#c0dd97';
  setTimeout(() => { btn.innerHTML = orig; btn.style.background = ''; }, 2500);
}

/* ── Crop profile ─────────────────────────────── */
function renderCrop(name) {
  const params = CROPS[name];
  el('cropParams').innerHTML = params.map(([k, v], i) =>
    `<div class="param-row" style="${i === params.length - 1 ? 'border:none' : ''}">
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

/* ── Mock time-series data ────────────────────── */
function genMoistureData(hours) {
  const labels = [], data = [];
  const now    = new Date();
  const step   = Math.max(1, Math.floor(hours / 10));
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
        {
          label: 'Soil moisture (%)',
          data,
          borderColor:     C_GREEN_MID,
          backgroundColor: C_GREEN_FILL,
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: C_GREEN_MID,
          fill: true,
          tension: 0.4,
        },
        {
          label: 'Optimal',
          data:  Array(n).fill(40),
          borderColor: C_GREEN_MID,
          borderWidth: 1.5,
          borderDash:  [6, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
        {
          label: 'Low threshold',
          data:  Array(n).fill(20),
          borderColor: C_ORANGE,
          borderWidth: 1.5,
          borderDash:  [4, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + '%' } },
      },
      scales: {
        x: {
          ticks: { color: C_TICK, font: { size: 9 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 9 },
          grid:  { color: C_GRID },
        },
        y: {
          min: 0, max: 80,
          ticks: { color: C_TICK, font: { size: 9 }, callback: v => v + '%' },
          grid:  { color: C_GRID },
        },
      },
    },
  });
}

/* ── Bar chart ────────────────────────────────── */
function buildBarChart() {
  const ctx     = el('historyBarChart').getContext('2d');
  const days    = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const avgData = [45, 55, 38, 62, 50, 47, 53];

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        label: 'Avg moisture (%)',
        data: avgData,
        backgroundColor: days.map((_, i) => i % 2 === 0 ? C_GREEN_ACCENT : C_GREEN_MID),
        borderRadius: 5,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ctx.parsed.y + '%' } },
      },
      scales: {
        x: {
          ticks: { color: C_TICK, font: { size: 10 } },
          grid:  { display: false },
        },
        y: {
          min: 0, max: 80,
          ticks: { color: C_TICK, font: { size: 9 }, callback: v => v + '%' },
          grid:  { color: C_GRID },
        },
      },
    },
    plugins: [{
      id: 'barLabels',
      afterDatasetsDraw(chart) {
        const { ctx, data } = chart;
        ctx.save();
        ctx.font      = '600 10px DM Sans, sans-serif';
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

/* ── Range selector ───────────────────────────── */
function updateRange(hours) { buildLineChart(Number(hours)); }

/* ── Simulate live sensor ticks ───────────────── */
function simulateLiveData() {
  setInterval(() => {
    state.moisture    = Math.min(100, Math.max(5,  state.moisture    + (Math.random() * 4 - 2)));
    state.temperature = Math.min(45,  Math.max(15, state.temperature + (Math.random() * 1 - 0.5)));
    state.humidity    = Math.min(100, Math.max(20, state.humidity    + (Math.random() * 2 - 1)));
    state.dataLogged += 1;

    // Auto pump logic
    if (state.moisture < 25) state.pumpOn = true;
    if (state.moisture > 60) state.pumpOn = false;

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
  simulateLiveData();
});