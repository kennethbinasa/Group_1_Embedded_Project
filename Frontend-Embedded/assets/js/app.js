/* ═══════════════════════════════════════════════
   AgroSense – app.js
   Dashboard logic: charts, pump control, live data
═══════════════════════════════════════════════ */

/* PLACEHOLDER BACKEND */
/* ── Simulated sensor state ───────────────────── */
const state = {
  moisture:    32,
  temperature: 26,
  humidity:    65,
  pumpOn:      true,
  dataLogged:  240,
};

/* ── Chart colour palette ─────────────────────── */
const GREEN_MID    = '#2d6a4f';
const GREEN_ACCENT = '#52b788';
const GREEN_LIGHT  = 'rgba(82,183,136,.18)';
const ORANGE       = '#e67e22';

/* ── Helpers ──────────────────────────────────── */
function updateBadge(id, text, cls) {
  const el = document.getElementById(id);
  el.textContent  = text;
  el.className    = 'stat-badge ' + cls;
}

function refreshCards() {
  // Soil Moisture
  document.getElementById('soilMoisture').textContent = state.moisture + '%';
  if (state.moisture < 30) {
    updateBadge('moistureBadge', 'Low', 'badge-low');
  } else if (state.moisture < 60) {
    updateBadge('moistureBadge', 'Optimal', 'badge-ok');
  } else {
    updateBadge('moistureBadge', 'Wet', 'badge-ok');
  }

  // Temperature & Humidity
  document.getElementById('temperature').textContent = state.temperature + '°C';
  document.getElementById('humidity').textContent    = state.humidity + '%';

  // Pump
  const icon  = document.getElementById('pumpIcon');
  const badge = document.getElementById('pumpBadge');
  if (state.pumpOn) {
    icon.className  = 'bi bi-power pump-on-anim';
    badge.textContent = 'Pump: ON';
    badge.className = 'stat-badge badge-on';
    document.getElementById('btnPumpToggle').textContent = 'Turn Pump OFF';
  } else {
    icon.className  = 'bi bi-power';
    badge.textContent = 'Pump: OFF';
    badge.className = 'stat-badge badge-off';
    document.getElementById('btnPumpToggle').textContent = 'Turn Pump ON';
  }

  // Data counter
  document.getElementById('dataLogged').textContent = state.dataLogged + ' Entries';
}

/* PLACEHOLDER MANUAL WATERING */
/* ── Pump control ─────────────────────────────── */
function togglePump() {
  state.pumpOn = !state.pumpOn;
  refreshCards();
}

function manualWater() {
  state.pumpOn = true;
  refreshCards();
  alert('💧 Manual watering started!');
}

/* PLACEHOLDER GRAPH HISTORY */
/* ── Generate mock time-series data ───────────── */
function genMoistureData(hours) {
  const labels = [], data = [];
  const now = new Date();
  for (let i = hours; i >= 0; i -= Math.max(1, Math.floor(hours / 10))) {
    const t = new Date(now - i * 3600000);
    labels.push(t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    // Simulate wavy moisture curve
    data.push(+(20 + 40 * Math.abs(Math.sin(i * 0.4 + 1)) + Math.random() * 8).toFixed(1));
  }
  return { labels, data };
}

/* ── Line Chart (Moisture over time) ─────────── */
let lineChart;

function buildLineChart(hours = 24) {
  const ctx = document.getElementById('moistureLineChart').getContext('2d');
  const { labels, data } = genMoistureData(hours);

  // Threshold annotation lines via dataset trick
  const optimalLine = Array(labels.length).fill(40);
  const lowLine     = Array(labels.length).fill(20);

  if (lineChart) lineChart.destroy();

  lineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Soil Moisture (%)',
          data,
          borderColor: GREEN_MID,
          backgroundColor: GREEN_LIGHT,
          borderWidth: 2.5,
          pointRadius: 3,
          pointBackgroundColor: GREEN_MID,
          fill: true,
          tension: 0.4,
        },
        {
          label: 'Optimal',
          data: optimalLine,
          borderColor: GREEN_ACCENT,
          borderWidth: 1.5,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
          tension: 0,
        },
        {
          label: 'Low Threshold',
          data: lowLine,
          borderColor: ORANGE,
          borderWidth: 1.5,
          borderDash: [4, 4],
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
        tooltip: {
          callbacks: {
            label: ctx => ctx.dataset.label + ': ' + ctx.parsed.y + '%',
          },
        },
      },
      scales: {
        x: {
          ticks: { color: '#5a7a65', font: { size: 10 } },
          grid:  { color: '#e8f5e9' },
        },
        y: {
          min: 0, max: 80,
          ticks: {
            color: '#5a7a65',
            font: { size: 10 },
            callback: v => v + '%',
          },
          grid: { color: '#e8f5e9' },
        },
      },
    },
  });
}

/* PLACEHOLDER HISTORY CHART */
/* ── Bar Chart (History Overview) ────────────── */
function buildBarChart() {
  const ctx = document.getElementById('historyBarChart').getContext('2d');

  const days    = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const avgData = [45, 55, 38, 62, 50, 47, 53];

  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [{
        label: 'Avg Moisture (%)',
        data: avgData,
        backgroundColor: days.map((_, i) =>
          i < 3 ? GREEN_MID : GREEN_ACCENT + 'aa'
        ),
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: ctx => ctx.parsed.y + '%' },
        },
        // Show value labels on bars
        datalabels: false,
      },
      scales: {
        x: {
          ticks: { color: '#5a7a65', font: { size: 11 } },
          grid:  { display: false },
        },
        y: {
          min: 0, max: 80,
          ticks: { color: '#5a7a65', font: { size: 10 }, callback: v => v + '%' },
          grid:  { color: '#e8f5e9' },
        },
      },
    },
    plugins: [{
      // Draw percentage labels above each bar
      id: 'barLabels',
      afterDatasetsDraw(chart) {
        const { ctx, data } = chart;
        ctx.save();
        ctx.font = 'bold 11px DM Sans, sans-serif';
        ctx.fillStyle = GREEN_MID;
        ctx.textAlign = 'center';
        chart.getDatasetMeta(0).data.forEach((bar, i) => {
          const val = data.datasets[0].data[i];
          ctx.fillText(val + '%', bar.x, bar.y - 6);
        });
        ctx.restore();
      },
    }],
  });
}

/* ── Range selector ───────────────────────────── */
function updateRange(hours) {
  buildLineChart(Number(hours));
}

/* PLACEHOLDER SENSOR FLUCTUATIONS */
/* TEMPORARY FRONTEND SIMULATION ( REPLACE WITH REAL SENSOR UPDATES ) */
/* ── Simulate live data ticks ─────────────────── */
function simulateLiveData() {
  setInterval(() => {
    // Gentle random walk
    state.moisture    = Math.min(100, Math.max(5,  state.moisture    + (Math.random() * 4 - 2)));
    state.temperature = Math.min(45,  Math.max(15, state.temperature + (Math.random() * 1 - 0.5)));
    state.humidity    = Math.min(100, Math.max(20, state.humidity    + (Math.random() * 2 - 1)));
    state.dataLogged += 1;

    // Auto pump: turn on if moisture drops below 25
    if (state.moisture < 25) state.pumpOn = true;
    if (state.moisture > 60) state.pumpOn = false;

    state.moisture    = +state.moisture.toFixed(1);
    state.temperature = +state.temperature.toFixed(1);
    state.humidity    = +state.humidity.toFixed(1);

    refreshCards();
  }, 3000); // update every 3 seconds
}

/* ── Init ─────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  refreshCards();
  buildLineChart(24);
  buildBarChart();
  simulateLiveData();
});