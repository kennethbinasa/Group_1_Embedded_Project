/* AgroSense - app.js
   Dashboard logic: charts, pump control, and backend data wiring */

/* ---- Sensor state ---- */
const state = {
  moisture: 38.4,
  temperature: 27.2,
  humidity: 65.2,
  pumpOn: false,
  dataLogged: 0,
  cropActive: 'Tomato',
  pumpCycles: 0,
  waterUsedML: 0,
  lastWateredSecs: null,
  pumpSeconds: 0,
  activeChartCrop: 'Tomato',
  moisturePechay: null,   // set from second sensor channel when available
  commandState: null
};

/* ---- API / WS config ---- */
const API_BASE = (() => {
  const runtimeBase = String(window.AGROSENSE_API_BASE || '').trim();
  if (runtimeBase.length > 0) {
    return runtimeBase.replace(/\/$/, '');
  }

  if (window.location.protocol === 'file:') return 'http://localhost:3000';
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  const host = window.location.hostname || 'localhost';
  return `${protocol}//${host}:3000`;
})();

const WS_URL = API_BASE.replace(/^http/, 'ws');

/* ---- Chart colours ---- */
const C_GREEN_MID = '#3b6d11';
const C_GREEN_ACCENT = '#97c459';
const C_GREEN_FILL = 'rgba(59,109,17,0.08)';
const C_ORANGE = '#ba7517';
const C_GRID = 'rgba(0,0,0,0.05)';
const C_TICK = '#7a9178';

/* ---- Crop profiles ---- */
const CROPS = {
  Tomato: [
    ['Daily VW demand', '600-1,200 mL'],
    ['FAO-56 Kc (mid)', '1.15'],
    ['Kc (late)', '0.70'],
    ['Root depth', '60-150 cm'],
    ['MAD threshold', '40%']
  ],
  Pechay: [
    ['Daily VW demand', '150-300 mL'],
    ['FAO-56 Kc (mid)', '0.95'],
    ['Kc (late)', '0.85'],
    ['Root depth', '15-30 cm'],
    ['MAD threshold', '35%']
  ]
};

let lineChart;
let barChart;
let ws;
let wsReconnectTimer;

/* ---- Helpers ---- */
function el(id) {
  return document.getElementById(id);
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function debounce(fn, waitMs) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}

async function apiFetch(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const err = await response.json();
      if (err && err.message) message = err.message;
    } catch (_err) {
      // Ignore JSON parse failures and keep HTTP status message.
    }
    throw new Error(message);
  }

  if (response.status === 204) return null;
  return response.json();
}

function fmtAgo(secs) {
  if (secs === null || secs === undefined) return 'No data';
  if (secs <= 0) return 'Just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setArc(arcId, fraction) {
  const arc = el(arcId);
  if (!arc) return;
  const offset = 195 - 195 * Math.min(1, Math.max(0, fraction));
  arc.setAttribute('stroke-dashoffset', offset.toFixed(1));
}

function tempFraction(t) {
  return (t - 15) / 30;
}

function humFraction(h) {
  return h / 100;
}

function tempStatus(t) {
  if (t < 18) return ['Cool', 'status-cool'];
  if (t < 24) return ['Mild', 'status-moderate'];
  if (t < 30) return ['Warm', 'status-warm'];
  return ['Hot', 'status-hot'];
}

function humStatus(h) {
  if (h < 30) return ['Dry', 'status-dry-air'];
  if (h < 60) return ['Moderate', 'status-moderate'];
  return ['Humid', 'status-humid'];
}

function moistureBadge(v) {
  if (v < 30) return ['DRY - Approaching Management Allowed Depletion', 'badge-dry'];
  if (v > 70) return ['ANOXIA RISK - Soil Saturation Dangerously High', 'badge-anoxia'];
  return ['OPTIMAL - Soil Moisture Within Safe Range', 'badge-optimal'];
}

function cropBadgeShort(v) {
  if (v < 30) return ['Dry',     'stat-badge vwc-crop-badge badge-dry'];
  if (v > 70) return ['Anoxia',  'stat-badge vwc-crop-badge badge-anoxia'];
  return              ['Optimal', 'stat-badge vwc-crop-badge badge-optimal'];
}

function setControlDisplayValues() {
  const pulseRange = el('rangePulseDuration');
  const pwmRange = el('rangePwm');
  const thresholdRange = el('rangeMoistureThreshold');
  if (pulseRange) el('durVal').textContent = `${pulseRange.value} min`;
  if (pwmRange) el('pwmVal').textContent = `${pwmRange.value}%`;
  if (thresholdRange) el('threshVal').textContent = `${thresholdRange.value}%`;
}

function setComfortRow(barId, statusId, value, color) {
  const bar = el(barId);
  const status = el(statusId);
  const pct = clamp(toNumber(value, 0), 0, 100);

  if (bar) {
    bar.style.width = `${pct}%`;
    bar.style.background = color;
  }

  if (status) {
    status.classList.remove('status-low-text', 'status-moderate-text', 'status-elevated-text');
    if (pct < 34) {
      status.textContent = 'Low';
      status.classList.add('status-low-text');
    } else if (pct < 67) {
      status.textContent = 'Moderate';
      status.classList.add('status-moderate-text');
    } else {
      status.textContent = 'Elevated';
      status.classList.add('status-elevated-text');
    }
  }
}

function setManualTargetSelect(crop) {
  const select = el('manualTargetCrop');
  if (!select) return;
  if (crop === 'Tomato' || crop === 'Pechay') {
    select.value = crop;
  }
}

function renderCommandState() {
  const label = el('commandSyncState');
  const detail = el('commandVersionState');
  const cmd = state.commandState;

  if (!label || !detail) return;
  if (!cmd || !cmd.servo || !cmd.pump) {
    label.textContent = 'Control sync: unavailable';
    detail.textContent = 'Servo v0/ack0 · Pump v0/ack0';
    return;
  }

  const pendingParts = [];
  if (cmd.servo.pending) pendingParts.push('servo pending');
  if (cmd.pump.pending) pendingParts.push('pump pending');

  if (pendingParts.length > 0) {
    label.textContent = `Control sync: ${pendingParts.join(', ')}`;
  } else {
    label.textContent = 'Control sync: acknowledged';
  }

  detail.textContent = `Servo v${cmd.servo.command_version}/ack${cmd.servo.ack_version} · Pump v${cmd.pump.command_version}/ack${cmd.pump.ack_version}`;
  setManualTargetSelect(cmd.servo.target_crop || state.cropActive);
}

/* ---- Card updates ---- */
function refreshCards() {

  // ── Tomato VWC row ────────────────────────────
  const tValEl = el('soilMoisture');
  if (tValEl) tValEl.textContent = `${state.moisture.toFixed(1)}%`;

  const tBadge = el('moistureBadgeTomato');
  if (tBadge) {
    const [txt, cls] = cropBadgeShort(state.moisture);
    tBadge.textContent = txt;
    tBadge.className = cls;
  }

  // ── Pechay VWC row ────────────────────────────
  const pValEl = el('soilMoisturePechay');
  const pBadge = el('moistureBadgePechay');
  if (pValEl && pBadge) {
    if (state.moisturePechay !== null && state.moisturePechay !== undefined) {
      pValEl.textContent = `${state.moisturePechay.toFixed(1)}%`;
      pValEl.style.color = 'var(--blue-val)';
      const [pt, pc] = cropBadgeShort(state.moisturePechay);
      pBadge.textContent = pt;
      pBadge.className = pc;
    } else {
      pValEl.textContent = '— %';
      pValEl.style.color = 'var(--text-muted)';
      pBadge.textContent = 'No data';
      pBadge.className = 'stat-badge vwc-crop-badge badge-off';
    }
  }

  // ── Overall soil status badge ─────────────────
  const [bTxt, bCls] = moistureBadge(state.moisture);
  const moistureBadgeEl = el('moistureBadge');
  if (moistureBadgeEl) {
    moistureBadgeEl.textContent = bTxt;
    moistureBadgeEl.className = `stat-badge ${bCls}`;
  }

  // ── Temperature gauge ─────────────────────────
  const tempVal = el('gaugeTempVal');
  if (tempVal) tempVal.textContent = state.temperature.toFixed(1);
  setArc('tempArc', tempFraction(state.temperature));
  const [tLabel, tCls] = tempStatus(state.temperature);
  const tempStatusEl = el('tempStatus');
  if (tempStatusEl) {
    tempStatusEl.textContent = tLabel;
    tempStatusEl.className = `gauge-tile-status ${tCls}`;
  }

  // ── Humidity gauge ────────────────────────────
  const humVal = el('gaugeHumVal');
  if (humVal) humVal.textContent = state.humidity.toFixed(1);
  setArc('humArc', humFraction(state.humidity));
  const [hLabel, hCls] = humStatus(state.humidity);
  const humStatusEl = el('humStatus');
  if (humStatusEl) {
    humStatusEl.textContent = hLabel;
    humStatusEl.className = `gauge-tile-status ${hCls}`;
  }

  // ── Pump card ─────────────────────────────────
  const ring   = el('pumpRing');
  const icon   = el('pumpIcon');
  const badge  = el('pumpBadge');
  const toggle = el('pumpToggleSwitch');
  const lbl    = el('toggleLabel');
  if (state.pumpOn) {
    if (ring)   ring.className  = 'pump-ring ring-on';
    if (icon)   icon.className  = 'bi bi-power pump-icon-big pump-on-color';
    if (badge)  { badge.textContent = 'Pump: ON';
      badge.className = 'stat-badge badge-on'; }
    if (toggle) toggle.checked  = true;
    if (lbl)    { lbl.textContent = 'ON';  lbl.style.color = '#3b6d11';
    }
  } else {
    if (ring)   ring.className  = 'pump-ring ring-off';
    if (icon)   icon.className  = 'bi bi-power pump-icon-big pump-off-color';
    if (badge)  { badge.textContent = 'Pump: OFF';
      badge.className = 'stat-badge badge-off'; }
    if (toggle) toggle.checked  = false;
    if (lbl)    { lbl.textContent = 'OFF'; lbl.style.color = '#a32d2d'; }
  }

  const runtime = el('pumpRuntime');
  if (runtime) runtime.textContent = fmtTime(state.pumpSeconds);

  const cycles = el('pumpCycles');
  if (cycles) cycles.textContent = String(state.pumpCycles);

  // ── Footer ────────────────────────────────────
  const dataLogged = el('dataLogged');
  if (dataLogged) dataLogged.textContent = `${state.dataLogged.toLocaleString()} Entries`;

  const lastWatered = el('lastWatered');
  if (lastWatered) lastWatered.textContent = fmtAgo(state.lastWateredSecs);

  const waterUsed = el('waterUsed');
  if (waterUsed) waterUsed.textContent = `${state.waterUsedML} mL`;
}

/* ---- Crop profile ---- */
function renderCrop(name) {
  const root = el('cropParams');
  if (!root || !CROPS[name]) return;
  root.innerHTML = CROPS[name]
    .map(
      ([k, v]) =>
        `<div class="param-row"><span class="param-key">${k}</span><span class="param-val">${v}</span></div>`
    )
    .join('');
}

async function selectCrop(name, persist = true) {
  state.cropActive = name;
  state.activeChartCrop = name;
  ['Tomato', 'Pechay'].forEach((c) => {
    const tab = el(`tab${c}`);
    if (tab) tab.classList.toggle('active', c === name);
  });

  // sync the chart crop dropdown if it exists
  const cropDrop = el('cropChartSelect');
  if (cropDrop) cropDrop.value = name;

  renderCrop(name);
  setManualTargetSelect(name);
  buildLineChart(Number(document.querySelector('.range-select')?.value || 24));

  if (!persist) return;
  try {
    await apiFetch('/api/settings/crop', {
      method: 'POST',
      body: JSON.stringify({ crop: name })
    });
  } catch (error) {
    console.error('Failed to save crop selection:', error.message);
  }
}

async function fetchCommandState() {
  try {
    const commands = await apiFetch('/api/commands/state');
    state.commandState = commands;
    renderCommandState();
  } catch (error) {
    console.error('Failed to fetch command state:', error.message);
  }
}

/* ---- Backend data sync ---- */
function applyLatestReading(latest) {
  if (!latest) return;

  state.temperature  = toNumber(latest.temperature, state.temperature);
  state.humidity     = toNumber(latest.humidity, state.humidity);
  state.moisture     = toNumber(latest.moisture ?? latest.soil_moisture, state.moisture);
  state.pumpOn       = typeof latest.pump_on === 'boolean' ? latest.pump_on : state.pumpOn;
  state.dataLogged   = toNumber(latest.data_logged, state.dataLogged);
  state.waterUsedML  = toNumber(latest.water_used_ml, state.waterUsedML);

  // Second sensor channel for Pechay (optional field)
  if (latest.moisture_pechay !== undefined) {
    state.moisturePechay = latest.moisture_pechay === null
      ?
      null
      : toNumber(latest.moisture_pechay, null);
  }

  if (latest.last_watered_secs === null || latest.last_watered_secs === undefined) {
    state.lastWateredSecs = null;
  } else {
    state.lastWateredSecs = Math.max(0, toNumber(latest.last_watered_secs, 0));
  }
}

function applySensorPush(payload) {
  if (!payload) return;
  state.temperature = toNumber(payload.temperature, state.temperature);
  state.humidity    = toNumber(payload.humidity, state.humidity);
  state.moisture    = toNumber(payload.moisture ?? payload.soil_moisture, state.moisture);

  if (payload.moisture_pechay !== undefined) {
    state.moisturePechay = payload.moisture_pechay === null
      ?
      null
      : toNumber(payload.moisture_pechay, null);
  }
}

async function fetchPumpStats() {
  const [runtimeResult, cyclesResult] = await Promise.allSettled([
    apiFetch('/api/pump/runtime'),
    apiFetch('/api/pump/cycles')
  ]);
  if (runtimeResult.status === 'fulfilled') {
    state.pumpSeconds = Math.max(0, toNumber(runtimeResult.value.seconds, state.pumpSeconds));
  }
  if (cyclesResult.status === 'fulfilled') {
    state.pumpCycles = Math.max(0, toNumber(cyclesResult.value.count, state.pumpCycles));
  }
}

async function fetchLatest() {
  try {
    const latest = await apiFetch('/api/sensors/latest');
    applyLatestReading(latest);
    await fetchPumpStats();
    refreshCards();
  } catch (error) {
    console.error('Failed to fetch latest sensor data:', error.message);
  }
}

async function loadSettings() {
  try {
    const settings = await apiFetch('/api/settings');
    const pulse     = el('rangePulseDuration');
    const pwm       = el('rangePwm');
    const threshold = el('rangeMoistureThreshold');

    if (pulse && settings.pulse_duration_min !== undefined) {
      pulse.value = String(clamp(toNumber(settings.pulse_duration_min, 30), 5, 120));
    }
    if (pwm && settings.pwm_duty_cycle !== undefined) {
      pwm.value = String(clamp(toNumber(settings.pwm_duty_cycle, 65), 0, 100));
    }
    if (threshold && settings.moisture_threshold !== undefined) {
      threshold.value = String(clamp(toNumber(settings.moisture_threshold, 30), 10, 60));
    }

    setControlDisplayValues();

    if (settings.crop && CROPS[settings.crop]) {
      await selectCrop(settings.crop, false);
    }
  } catch (error) {
    console.error('Failed to load settings:', error.message);
  }
}

async function fetchComfortIndex() {
  try {
    const comfort = await apiFetch('/api/environment/comfort-index');
    setComfortRow('comfortHeatBar',   'comfortHeatStatus',   comfort.heat_stress,       '#ef9f27');
    setComfortRow('comfortEtBar',     'comfortEtStatus',     comfort.evapotranspiration, '#3b6d11');
    setComfortRow('comfortFungalBar', 'comfortFungalStatus', comfort.fungal_risk,        '#7f77dd');
  } catch (error) {
    console.error('Failed to fetch comfort index:', error.message);
  }
}

/* ---- Pump controls ---- */
async function togglePumpSwitch() {
  const toggle = el('pumpToggleSwitch');
  if (!toggle) return;
  const desiredState = !!toggle.checked;
  try {
    const response = await apiFetch('/api/pump/toggle', {
      method: 'POST',
      body: JSON.stringify({ state: desiredState })
    });
    state.pumpOn = !!response.pump_on;
    await fetchCommandState();
    await fetchPumpStats();
    refreshCards();
  } catch (error) {
    toggle.checked = state.pumpOn;
    console.error('Failed to toggle pump:', error.message);
  }
}

async function manualWater() {
  const btn = el('btnManualWater');
  if (!btn) return;
  const durationMinutes = clamp(toNumber(el('rangePulseDuration')?.value, 30), 1, 120);
  const targetCrop = String(el('manualTargetCrop')?.value || state.cropActive || 'Tomato');
  const originalMarkup  = btn.innerHTML;
  btn.disabled = true;

  try {
    await apiFetch('/api/servo/target', {
      method: 'POST',
      body: JSON.stringify({ crop: targetCrop, source: 'manual_override' })
    });

    await apiFetch('/api/pump/manual', {
      method: 'POST',
      body: JSON.stringify({ duration_minutes: durationMinutes, target_crop: targetCrop })
    });

    state.pumpOn = true;
    state.lastWateredSecs = 0;
    await fetchCommandState();
    refreshCards();

    btn.innerHTML      = `<i class="bi bi-check2 me-1"></i>Watering ${targetCrop}...`;
    btn.style.background = '#c0dd97';
  } catch (error) {
    console.error('Failed to trigger manual watering:', error.message);
  } finally {
    setTimeout(() => {
      btn.innerHTML      = originalMarkup;
      btn.style.background = '';
      btn.disabled       = false;
    }, 2500);
  }
}

/* ---- Chart builders ---- */
async function buildLineChart(hours = 24) {
  let labels = [];
  let data   = [];

  try {
    const history = await apiFetch(
      `/api/sensors/moisture/history?hours=${encodeURIComponent(hours)}&crop=${encodeURIComponent(state.activeChartCrop)}`
    );
    labels = Array.isArray(history?.labels) ? history.labels : [];
    data   = Array.isArray(history?.data)
      ?
      history.data.map((v) => toNumber(v, state.moisture))
      : [];
  } catch (error) {
    console.error('Failed to fetch moisture history:', error.message);
  }

  if (labels.length === 0 || data.length === 0) {
    labels = ['Now'];
    data   = [state.activeChartCrop === 'Pechay' && state.moisturePechay !== null
      ?
      state.moisturePechay
      : state.moisture];
  }

  const ctx = el('moistureLineChart')?.getContext('2d');
  if (!ctx) return;

  if (lineChart) lineChart.destroy();
  const isPechay     = state.activeChartCrop === 'Pechay';
  const lineColor    = isPechay ?
    '#185fa5' : C_GREEN_MID;
  const fillColor    = isPechay ? 'rgba(24,95,165,0.08)' : C_GREEN_FILL;
  const pointColor   = isPechay ? '#185fa5' : C_GREEN_MID;
  lineChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: `${state.activeChartCrop} Moisture (%)`,
          data,
          borderColor:          lineColor,
          backgroundColor:      fillColor,
      
          borderWidth:          2,
          pointRadius:          3,
          pointBackgroundColor: pointColor,
          fill:                 true,
          tension:              0.4
    
        },
        {
          label: 'Optimal',
          data: Array(labels.length).fill(40),
          borderColor: C_GREEN_MID,
          borderWidth: 1.5,
          borderDash:  [6, 4],
          pointRadius: 0,
          fill:        false
  
        },
        {
          label: 'Low threshold',
          data: Array(labels.length).fill(20),
          borderColor: C_ORANGE,
          borderWidth: 1.5,
          borderDash:  [4, 4],
          pointRadius: 0,
          fill:       
         false
        }
      ]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: 
            (c) => `${c.dataset.label}: ${c.parsed.y}%` }
        }
      },
      scales: {
        x: {
          ticks: {
            color:         C_TICK,
            font:          { size: 9 },
         
            maxRotation:   0,
            autoSkip:      true,
            maxTicksLimit: 9
          },
          grid: { color: C_GRID }
        },
        y: {
          min: 0,
          max: 
            80,
          title: {
            display: true,
            text:    `${state.activeChartCrop} Moisture (%)`,
            color:   C_TICK,
            font:    { size: 9 }
          },
          ticks: {
   
            color:         C_TICK,
            font:          { size: 9 },
            callback:      (v) => v,
            maxTicksLimit: 6
          },
          grid: { color: C_GRID 
          }
        }
      }
    }
  });
}

async function buildBarChart() {
  let days     = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  let averages = [0, 0, 0, 0, 0, 0, 0];

  try {
    const weekly = await apiFetch('/api/sensors/moisture/weekly-average');
    if (Array.isArray(weekly?.days) && Array.isArray(weekly?.averages) && weekly.days.length > 0) {
      days     = weekly.days;
      averages = weekly.averages.map((v) => toNumber(v, 0));
    }
  } catch (error) {
    console.error('Failed to fetch weekly averages:', error.message);
  }

  const ctx = el('historyBarChart')?.getContext('2d');
  if (!ctx) return;

  if (barChart) barChart.destroy();
  barChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: days,
      datasets: [
        {
          label: 'Avg moisture (%)',
          data:  averages,
          backgroundColor: days.map((_, i) => (i % 2 === 0 ? C_GREEN_ACCENT : C_GREEN_MID)),
          borderRadius:    5,
   
          borderSkipped:   false
        }
      ]
    },
    options: {
      responsive:          true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.parsed.y}%` } }
      },
  
      scales: {
        x: { ticks: { color: C_TICK, font: { size: 10 } }, grid: { display: false } },
        y: {
          min: 0, max: 80,
          ticks: { color: C_TICK, font: { size: 9 }, callback: (v) => v, maxTicksLimit: 6 },
          grid:  { color: C_GRID }
        
        }
      }
    },
    plugins: [
      {
        id: 'barLabels',
        afterDatasetsDraw(chart) {
          const { ctx: chartCtx, data: chartData } = chart;
          chartCtx.save();
          chartCtx.font      = '600 11px DM Sans,sans-serif';
          chartCtx.fillStyle = C_GREEN_MID;
          chartCtx.textAlign = 'center';
          chart.getDatasetMeta(0).data.forEach((bar, i) => {
            chartCtx.fillText(`${chartData.datasets[0].data[i]}%`, bar.x, bar.y - 5);
          });
          chartCtx.restore();
        }
      }
    ]
  });
}

/* ---- Range / crop selectors ---- */
function updateRange(hours) {
  buildLineChart(Number(hours));
}

function updateChartCrop(crop) {
  state.activeChartCrop = crop;
  const hours = Number(document.querySelector('.range-select')?.value || 24);
  buildLineChart(hours);
}

/* ---- Slider listeners ---- */
function bindControlListeners() {
  const pulseRange     = el('rangePulseDuration');
  const pwmRange       = el('rangePwm');
  const thresholdRange = el('rangeMoistureThreshold');
  const sendPulseDuration = debounce(async (value) => {
    try {
      await apiFetch('/api/settings/pulse-duration', {
        method: 'POST',
        body: JSON.stringify({ minutes: toNumber(value, 30) })
      });
    } catch (error) {
      console.error('Failed to update pulse duration:', error.message);
    }
  }, 350);
  const sendPwm = debounce(async (value) => {
    try {
      await apiFetch('/api/pump/pwm', {
        method: 'POST',
        body: JSON.stringify({ duty_cycle: toNumber(value, 65) })
      });
    } catch (error) {
      console.error('Failed to update PWM duty cycle:', error.message);
    }
  }, 350);
  const sendMoistureThreshold = debounce(async (value) => {
    try {
      await apiFetch('/api/settings/moisture-threshold', {
        method: 'POST',
        body: JSON.stringify({ vwc: toNumber(value, 30) })
      });
    } catch (error) {
      console.error('Failed to update moisture threshold:', error.message);
    }
  }, 350);
  if (pulseRange) {
    pulseRange.addEventListener('input', () => {
      el('durVal').textContent = `${pulseRange.value} min`;
      sendPulseDuration(pulseRange.value);
    });
  }

  if (pwmRange) {
    pwmRange.addEventListener('input', () => {
      el('pwmVal').textContent = `${pwmRange.value}%`;
      sendPwm(pwmRange.value);
    });
  }

  if (thresholdRange) {
    thresholdRange.addEventListener('input', () => {
      el('threshVal').textContent = `${thresholdRange.value}%`;
      sendMoistureThreshold(thresholdRange.value);
    });
  }
}

/* ---- WebSocket wiring ---- */
function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  try {
    ws = new WebSocket(WS_URL);
  } catch (error) {
    console.error('WebSocket init failed:', error.message);
    scheduleWebSocketReconnect();
    return;
  }

  ws.addEventListener('message', async (event) => {
    try {
      const payload = JSON.parse(event.data);

      if (payload.type === 'sensor_update') {
        applySensorPush(payload.data);
        state.dataLogged += 1;
        refreshCards();
        await buildLineChart(Number(document.querySelector('.range-select')?.value || 24));
        await buildBarChart();
      }

      if (payload.type === 'pump_update') {
      
        state.pumpOn = !!payload.data?.pump_on;
        await fetchCommandState();
        await fetchPumpStats();
        refreshCards();
      }

      if (payload.type === 'command_update') {
        state.commandState = payload.data;
        renderCommandState();
      }
    } catch (_err) {
      // Ignore malformed push payloads.
    }
  });
  ws.addEventListener('close', () => {
    scheduleWebSocketReconnect();
  });
  ws.addEventListener('error', () => {
    try { ws.close(); } catch (_err) { /* ignore */ }
  });
}

function scheduleWebSocketReconnect() {
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = setTimeout(connectWebSocket, 3000);
}

/* ---- Runtime ticker ---- */
function startRuntimeTicker() {
  setInterval(() => {
    if (state.pumpOn) {
      state.pumpSeconds += 1;
    }
    if (state.lastWateredSecs !== null && state.lastWateredSecs !== undefined) {
      state.lastWateredSecs += 1;
    }
    refreshCards();
  }, 1000);
}

/* ---- Init ---- */
document.addEventListener('DOMContentLoaded', async () => {
  refreshCards();
  renderCrop(state.cropActive);
  setControlDisplayValues();
  bindControlListeners();

  await loadSettings();

  await Promise.all([
    fetchLatest(),
    fetchCommandState(),
    buildLineChart(Number(document.querySelector('.range-select')?.value || 24)),
    buildBarChart(),
    fetchComfortIndex()
  ]);

  connectWebSocket();
  startRuntimeTicker();

  setInterval(fetchLatest, 5000);
  setInterval(fetchComfortIndex, 30000);
});