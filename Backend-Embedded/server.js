const path = require('path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, 'agrosense.db');
const FRONTEND_PATH = path.join(__dirname, '..', 'Frontend-Embedded');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(FRONTEND_PATH));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    temperature REAL NOT NULL,
    humidity REAL NOT NULL,
    soil_moisture REAL NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pump_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state INTEGER NOT NULL,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

const sensorColumns = db
  .prepare('PRAGMA table_info(sensor_readings)')
  .all()
  .map((column) => column.name);

const isLegacySensorSchema =
  sensorColumns.includes('temperature_c') &&
  sensorColumns.includes('humidity_pct') &&
  sensorColumns.includes('moisture_pct') &&
  sensorColumns.includes('timestamp');

const pumpColumns = db
  .prepare('PRAGMA table_info(pump_events)')
  .all()
  .map((column) => column.name);

const hasStatePumpSchema = pumpColumns.includes('state') && pumpColumns.includes('created_at');

const selectSensorSql = isLegacySensorSchema
  ? `SELECT
       id,
       temperature_c AS temperature,
       humidity_pct AS humidity,
       moisture_pct AS moisture,
       COALESCE(flow_ml, 0) AS flow_ml,
       timestamp AS recorded_at
     FROM sensor_readings`
  : `SELECT
       id,
       temperature,
       humidity,
       soil_moisture AS moisture,
       0 AS flow_ml,
       recorded_at
     FROM sensor_readings`;

const insertReadingStmt = isLegacySensorSchema
  ? db.prepare(`
      INSERT INTO sensor_readings (timestamp, moisture_pct, temperature_c, humidity_pct, flow_ml, device_id)
      VALUES (@timestamp, @moisture, @temperature, @humidity, @flow_ml, @device_id)
    `)
  : db.prepare(`
      INSERT INTO sensor_readings (temperature, humidity, soil_moisture)
      VALUES (@temperature, @humidity, @moisture)
    `);

const latestReadingStmt = db.prepare(`${selectSensorSql} ORDER BY id DESC LIMIT 1`);
const historyReadingStmt = db.prepare(`${selectSensorSql} ORDER BY id DESC LIMIT ?`);
const insertedReadingStmt = db.prepare(`${selectSensorSql} WHERE id = ?`);
const countReadingsStmt = db.prepare('SELECT COUNT(*) AS count FROM sensor_readings');
const settingsAllStmt = db.prepare('SELECT key, value FROM settings');
const settingByKeyStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const settingsColumns = db
  .prepare('PRAGMA table_info(settings)')
  .all()
  .map((column) => column.name);

const hasSettingsUpdatedAt = settingsColumns.includes('updated_at');
const hasSettingsCreatedAt = settingsColumns.includes('created_at');

const upsertSettingStmt = hasSettingsCreatedAt && hasSettingsUpdatedAt
  ? db.prepare(`
      INSERT INTO settings (key, value, created_at, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = CURRENT_TIMESTAMP
    `)
  : hasSettingsUpdatedAt
    ? db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = CURRENT_TIMESTAMP
      `)
    : db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

function ensureSettingDefault(key, value) {
  const existing = settingByKeyStmt.get(key);
  if (!existing) {
    upsertSettingStmt.run(key, String(value));
  }
}

ensureSettingDefault('crop', 'Tomato');
ensureSettingDefault('pulse_duration_min', '30');
ensureSettingDefault('pwm_duty_cycle', '65');
ensureSettingDefault('moisture_threshold', '30');

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

function normalizeReading(row) {
  if (!row) return null;
  return {
    ...row,
    soil_moisture: row.moisture
  };
}

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isNaN(numeric) ? fallback : numeric;
}

function getPumpStatus() {
  if (hasStatePumpSchema) {
    const row = db.prepare('SELECT state FROM pump_events ORDER BY id DESC LIMIT 1').get();
    return row ? row.state === 1 : false;
  }

  const row = db.prepare('SELECT end_time FROM pump_events ORDER BY id DESC LIMIT 1').get();
  return row ? row.end_time === null : false;
}

function getLastWateredTimestamp() {
  if (hasStatePumpSchema) {
    const row = db
      .prepare('SELECT created_at FROM pump_events WHERE state = 1 ORDER BY id DESC LIMIT 1')
      .get();
    return row ? row.created_at : null;
  }

  const row = db.prepare('SELECT start_time FROM pump_events ORDER BY id DESC LIMIT 1').get();
  return row ? row.start_time : null;
}

function getPumpCyclesToday() {
  if (hasStatePumpSchema) {
    const row = db
      .prepare(`
        SELECT COUNT(*) AS count
        FROM pump_events
        WHERE state = 1 AND DATE(created_at) = DATE('now')
      `)
      .get();
    return row.count;
  }

  const row = db
    .prepare(`
      SELECT COUNT(*) AS count
      FROM pump_events
      WHERE DATE(start_time) = DATE('now')
    `)
    .get();

  return row.count;
}

function getPumpRuntimeSeconds() {
  if (hasStatePumpSchema) {
    const events = db
      .prepare('SELECT state, created_at FROM pump_events ORDER BY id ASC')
      .all();

    let runtime = 0;
    let activeSince = null;

    for (const ev of events) {
      if (ev.state === 1 && activeSince === null) {
        activeSince = new Date(ev.created_at).getTime();
        continue;
      }

      if (ev.state === 0 && activeSince !== null) {
        const end = new Date(ev.created_at).getTime();
        runtime += Math.max(0, Math.floor((end - activeSince) / 1000));
        activeSince = null;
      }
    }

    if (activeSince !== null) {
      runtime += Math.max(0, Math.floor((Date.now() - activeSince) / 1000));
    }

    return runtime;
  }

  const events = db
    .prepare('SELECT start_time, end_time, duration_secs FROM pump_events ORDER BY id ASC')
    .all();

  let runtime = 0;

  for (const ev of events) {
    if (typeof ev.duration_secs === 'number') {
      runtime += Math.max(0, ev.duration_secs);
      continue;
    }

    if (ev.start_time && ev.end_time) {
      const start = new Date(ev.start_time).getTime();
      const end = new Date(ev.end_time).getTime();
      runtime += Math.max(0, Math.floor((end - start) / 1000));
      continue;
    }

    if (ev.start_time && !ev.end_time) {
      const start = new Date(ev.start_time).getTime();
      runtime += Math.max(0, Math.floor((Date.now() - start) / 1000));
    }
  }

  return runtime;
}

function setPumpState(state, source) {
  if (hasStatePumpSchema) {
    db.prepare('INSERT INTO pump_events (state, source) VALUES (?, ?)').run(state ? 1 : 0, source);
    return;
  }

  if (state) {
    db.prepare(
      `
        INSERT INTO pump_events (start_time, end_time, duration_secs, trigger_type, water_ml)
        VALUES (?, NULL, NULL, ?, 0)
      `
    ).run(new Date().toISOString(), source);
    return;
  }

  const open = db
    .prepare(
      `
        SELECT id, start_time
        FROM pump_events
        WHERE end_time IS NULL
        ORDER BY id DESC
        LIMIT 1
      `
    )
    .get();

  if (!open) return;

  const nowIso = new Date().toISOString();
  const durationSecs = Math.max(
    0,
    Math.floor((new Date(nowIso).getTime() - new Date(open.start_time).getTime()) / 1000)
  );

  db.prepare('UPDATE pump_events SET end_time = ?, duration_secs = ? WHERE id = ?').run(
    nowIso,
    durationSecs,
    open.id
  );
}

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get('/api/sensors/latest', (_req, res) => {
  const row = normalizeReading(latestReadingStmt.get());
  if (!row) {
    return res.status(404).json({ message: 'No sensor data available yet.' });
  }

  const logged = countReadingsStmt.get();
  const lastWatered = getLastWateredTimestamp();

  return res.status(200).json({
    ...row,
    pump_on: getPumpStatus(),
    data_logged: logged.count,
    water_used_ml: row.flow_ml || 0,
    last_watered_secs: lastWatered
      ? Math.floor((Date.now() - new Date(lastWatered).getTime()) / 1000)
      : null
  });
});

app.get('/api/sensors/history', (req, res) => {
  const limitRaw = Number.parseInt(req.query.limit, 10);
  const limit = Number.isNaN(limitRaw) ? 20 : Math.min(Math.max(limitRaw, 1), 500);
  const rows = historyReadingStmt.all(limit).reverse().map(normalizeReading);
  return res.status(200).json(rows);
});

app.get('/api/sensors/moisture', (_req, res) => {
  const row = normalizeReading(latestReadingStmt.get());
  if (!row) return res.status(404).json({ message: 'No sensor data available yet.' });
  return res.status(200).json({ moisture: row.moisture });
});

app.get('/api/sensors/temperature', (_req, res) => {
  const row = normalizeReading(latestReadingStmt.get());
  if (!row) return res.status(404).json({ message: 'No sensor data available yet.' });
  return res.status(200).json({ temperature: row.temperature });
});

app.get('/api/sensors/humidity', (_req, res) => {
  const row = normalizeReading(latestReadingStmt.get());
  if (!row) return res.status(404).json({ message: 'No sensor data available yet.' });
  return res.status(200).json({ humidity: row.humidity });
});

app.get('/api/sensors/flow', (_req, res) => {
  const row = normalizeReading(latestReadingStmt.get());
  if (!row) return res.status(404).json({ message: 'No sensor data available yet.' });
  return res.status(200).json({ flow_ml: row.flow_ml || 0 });
});

app.get('/api/sensors/moisture/history', (req, res) => {
  const hours = Math.min(Math.max(toNumber(req.query.hours, 24), 1), 168);
  const cutoff = new Date(Date.now() - hours * 3600000).toISOString();
  const tsCol = isLegacySensorSchema ? 'timestamp' : 'recorded_at';

  const rows = db
    .prepare(`${selectSensorSql} WHERE ${tsCol} >= ? ORDER BY id ASC`)
    .all(cutoff)
    .map(normalizeReading);

  return res.status(200).json({
    labels: rows.map((r) =>
      new Date(r.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    ),
    data: rows.map((r) => +toNumber(r.moisture, 0).toFixed(1))
  });
});

app.get('/api/sensors/moisture/weekly-average', (_req, res) => {
  const tsCol = isLegacySensorSchema ? 'timestamp' : 'recorded_at';
  const moistureCol = isLegacySensorSchema ? 'moisture_pct' : 'soil_moisture';

  const rows = db
    .prepare(`
      SELECT
        strftime('%w', ${tsCol}) AS dow,
        ROUND(AVG(${moistureCol}), 1) AS avg_moisture
      FROM sensor_readings
      WHERE ${tsCol} >= datetime('now', '-7 days')
      GROUP BY dow
      ORDER BY dow
    `)
    .all();

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return res.status(200).json({
    days: rows.map((r) => dayNames[toNumber(r.dow, 0)]),
    averages: rows.map((r) => r.avg_moisture)
  });
});

app.post('/api/data', (req, res) => {
  const temperature = toNumber(req.body.temperature ?? req.body.temperature_c, NaN);
  const humidity = toNumber(req.body.humidity ?? req.body.humidity_pct, NaN);
  const moisture = toNumber(
    req.body.soil_moisture ?? req.body.soilMoisture ?? req.body.moisture ?? req.body.moisture_pct,
    NaN
  );
  const flowMl = toNumber(req.body.flow_ml, 0);

  if (Number.isNaN(temperature) || Number.isNaN(humidity) || Number.isNaN(moisture)) {
    return res.status(400).json({
      message:
        'Invalid payload. Required numeric fields: temperature, humidity, soil_moisture (or moisture/moisture_pct).'
    });
  }

  const info = isLegacySensorSchema
    ? insertReadingStmt.run({
        timestamp: new Date().toISOString(),
        temperature,
        humidity,
        moisture,
        flow_ml: flowMl,
        device_id: req.body.device_id || null
      })
    : insertReadingStmt.run({
        temperature,
        humidity,
        moisture
      });

  const inserted = normalizeReading(insertedReadingStmt.get(info.lastInsertRowid));
  broadcast('sensor_update', inserted);

  return res.status(201).json(inserted);
});

app.get('/api/pump/status', (_req, res) => {
  return res.status(200).json({ pump_on: getPumpStatus() });
});

app.get('/api/pump/runtime', (_req, res) => {
  return res.status(200).json({ seconds: getPumpRuntimeSeconds() });
});

app.get('/api/pump/cycles', (_req, res) => {
  return res.status(200).json({ count: getPumpCyclesToday() });
});

app.get('/api/pump/last-watered', (_req, res) => {
  const lastWatered = getLastWateredTimestamp();
  if (!lastWatered) {
    return res.status(404).json({ message: 'No pump events yet.' });
  }

  return res.status(200).json({ timestamp: lastWatered });
});

app.post('/api/pump/toggle', (req, res) => {
  const state = req.body.state === true || req.body.state === 1;
  setPumpState(state, 'toggle');

  const response = { pump_on: state };
  broadcast('pump_update', response);

  return res.status(200).json(response);
});

app.post('/api/pump/manual', (req, res) => {
  const durationMinutes = Math.min(Math.max(toNumber(req.body.duration_minutes, 1), 1), 120);

  setPumpState(true, 'manual');
  broadcast('pump_update', { pump_on: true });

  setTimeout(() => {
    setPumpState(false, 'manual_end');
    broadcast('pump_update', { pump_on: false });
  }, durationMinutes * 60 * 1000);

  return res.status(200).json({
    message: `Manual watering started for ${durationMinutes} minute(s).`,
    duration_minutes: durationMinutes
  });
});

app.post('/api/pump/pwm', (req, res) => {
  const dutyCycle = Math.min(Math.max(toNumber(req.body.duty_cycle, 0), 0), 100);
  upsertSettingStmt.run('pwm_duty_cycle', String(dutyCycle));
  return res.status(200).json({ duty_cycle: dutyCycle });
});

app.get('/api/settings', (_req, res) => {
  const rows = settingsAllStmt.all();
  return res.status(200).json(Object.fromEntries(rows.map((r) => [r.key, r.value])));
});

app.post('/api/settings', (req, res) => {
  const allowed = new Set(['crop', 'pulse_duration_min', 'pwm_duty_cycle', 'moisture_threshold']);
  const updated = [];

  for (const [key, value] of Object.entries(req.body || {})) {
    if (!allowed.has(key)) continue;
    upsertSettingStmt.run(key, String(value));
    updated.push(key);
  }

  return res.status(200).json({ updated });
});

app.get('/api/settings/crop', (_req, res) => {
  const row = settingByKeyStmt.get('crop');
  return res.status(200).json({ crop: row ? row.value : 'Tomato' });
});

app.post('/api/settings/crop', (req, res) => {
  const crop = String(req.body.crop || 'Tomato');
  upsertSettingStmt.run('crop', crop);
  return res.status(200).json({ crop });
});

app.post('/api/settings/pulse-duration', (req, res) => {
  const minutes = Math.min(Math.max(toNumber(req.body.minutes, 30), 1), 120);
  upsertSettingStmt.run('pulse_duration_min', String(minutes));
  return res.status(200).json({ minutes });
});

app.post('/api/settings/moisture-threshold', (req, res) => {
  const vwc = Math.min(Math.max(toNumber(req.body.vwc, 30), 0), 100);
  upsertSettingStmt.run('moisture_threshold', String(vwc));
  return res.status(200).json({ vwc });
});

app.get('/api/crops', (_req, res) => {
  return res.status(200).json(CROPS);
});

app.get('/api/crops/:name', (req, res) => {
  const crop = CROPS[req.params.name];
  if (!crop) return res.status(404).json({ message: 'Crop not found.' });
  return res.status(200).json(crop);
});

app.get('/api/stats/data-logged', (_req, res) => {
  return res.status(200).json({ count: countReadingsStmt.get().count });
});

app.get('/api/device/info', (_req, res) => {
  return res.status(200).json({ name: 'AgroSense Network', version: '1.0.0' });
});

app.get('/api/environment/comfort-index', (_req, res) => {
  return res.status(200).json({ heat_stress: 55, evapotranspiration: 28, fungal_risk: 70 });
});

app.get('/api/environment/evapotranspiration', (_req, res) => {
  return res.status(200).json({ value: 28, status: 'low' });
});

function shutdown() {
  try {
    wss.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  } catch (_error) {
    process.exit(1);
  }
}

const server = app.listen(PORT);

server.on('listening', () => {
  console.log(`Using ${isLegacySensorSchema ? 'legacy' : 'modern'} sensor_readings schema`);
  console.log(`Using ${hasStatePumpSchema ? 'state-based' : 'legacy interval'} pump_events schema`);
  console.log(`AgroSense backend running on port ${PORT}`);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the existing process or use a different PORT.`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

const wss = new WebSocketServer({ server });
wss.on('error', (error) => {
  console.error('WebSocket server error:', error.message);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
