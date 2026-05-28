const path = require('path');
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, 'agrosense.db');
const FRONTEND_PATH = path.join(__dirname, '..', 'Frontend-Embedded');
const INGEST_API_KEY = process.env.INGEST_API_KEY || '';

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

let sensorColumns = db
  .prepare('PRAGMA table_info(sensor_readings)')
  .all()
  .map((column) => column.name);

let isLegacySensorSchema =
  sensorColumns.includes('temperature_c') &&
  sensorColumns.includes('humidity_pct') &&
  sensorColumns.includes('moisture_pct') &&
  sensorColumns.includes('timestamp');

if (!sensorColumns.includes('moisture_tomato')) {
  db.exec('ALTER TABLE sensor_readings ADD COLUMN moisture_tomato REAL');
}

if (!sensorColumns.includes('moisture_pechay')) {
  db.exec('ALTER TABLE sensor_readings ADD COLUMN moisture_pechay REAL');
}

sensorColumns = db
  .prepare('PRAGMA table_info(sensor_readings)')
  .all()
  .map((column) => column.name);

const hasMoistureTomatoColumn = !isLegacySensorSchema && sensorColumns.includes('moisture_tomato');
const hasMoisturePechayColumn = !isLegacySensorSchema && sensorColumns.includes('moisture_pechay');
const hasLegacyMoisture1Column = isLegacySensorSchema && sensorColumns.includes('moisture1_pct');
const hasLegacyMoisture2Column = isLegacySensorSchema && sensorColumns.includes('moisture2_pct');

const pumpColumns = db
  .prepare('PRAGMA table_info(pump_events)')
  .all()
  .map((column) => column.name);

const hasStatePumpSchema = pumpColumns.includes('state') && pumpColumns.includes('created_at');

const selectTomatoExpr = hasMoistureTomatoColumn
  ? 'COALESCE(moisture_tomato, soil_moisture) AS moisture_tomato'
  : 'soil_moisture AS moisture_tomato';
const selectPechayExpr = hasMoisturePechayColumn
  ? 'moisture_pechay'
  : 'NULL AS moisture_pechay';

const selectSensorSql = isLegacySensorSchema
  ? `SELECT
       id,
       temperature_c AS temperature,
       humidity_pct AS humidity,
       moisture_pct AS moisture,
       COALESCE(moisture1_pct, moisture_tomato, moisture_pct) AS moisture_tomato,
       COALESCE(moisture2_pct, moisture_pechay) AS moisture_pechay,
       COALESCE(flow_ml, 0) AS flow_ml,
       timestamp AS recorded_at
     FROM sensor_readings`
  : `SELECT
       id,
       temperature,
       humidity,
       soil_moisture AS moisture,
       ${selectTomatoExpr},
       ${selectPechayExpr},
       0 AS flow_ml,
       recorded_at
     FROM sensor_readings`;

const insertReadingStmt = isLegacySensorSchema
  ? hasLegacyMoisture1Column && hasLegacyMoisture2Column
    ? db.prepare(`
        INSERT INTO sensor_readings (
          timestamp,
          moisture_pct,
          moisture1_pct,
          moisture2_pct,
          moisture_tomato,
          moisture_pechay,
          temperature_c,
          humidity_pct,
          flow_ml,
          device_id
        )
        VALUES (
          @timestamp,
          @moisture,
          @moisture1_pct,
          @moisture2_pct,
          @moisture_tomato,
          @moisture_pechay,
          @temperature,
          @humidity,
          @flow_ml,
          @device_id
        )
      `)
    : db.prepare(`
        INSERT INTO sensor_readings (timestamp, moisture_pct, temperature_c, humidity_pct, flow_ml, device_id)
        VALUES (@timestamp, @moisture, @temperature, @humidity, @flow_ml, @device_id)
      `)
  : hasMoistureTomatoColumn && hasMoisturePechayColumn
    ? db.prepare(`
        INSERT INTO sensor_readings (temperature, humidity, soil_moisture, moisture_tomato, moisture_pechay)
        VALUES (@temperature, @humidity, @moisture, @moisture_tomato, @moisture_pechay)
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
ensureSettingDefault('control_version', '0');
ensureSettingDefault('pump_target_state', '0');
ensureSettingDefault('pump_command_version', '0');
ensureSettingDefault('pump_ack_version', '0');
ensureSettingDefault('pump_actual_state', '0');
ensureSettingDefault('pump_command_issued_at', '');
ensureSettingDefault('pump_command_ack_at', '');
ensureSettingDefault('servo_target_crop', 'Tomato');
ensureSettingDefault('servo_command_version', '0');
ensureSettingDefault('servo_ack_version', '0');
ensureSettingDefault('servo_actual_crop', 'Tomato');
ensureSettingDefault('servo_command_issued_at', '');
ensureSettingDefault('servo_command_ack_at', '');

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

  const moistureTomato = row.moisture_tomato !== null && row.moisture_tomato !== undefined && Number.isFinite(Number(row.moisture_tomato))
    ? Number(row.moisture_tomato)
    : row.moisture;
  const moisturePechay = row.moisture_pechay !== null && row.moisture_pechay !== undefined && Number.isFinite(Number(row.moisture_pechay))
    ? Number(row.moisture_pechay)
    : null;

  return {
    ...row,
    soil_moisture: row.moisture,
    moisture_tomato: moistureTomato,
    moisture_pechay: moisturePechay
  };
}

function toNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isNaN(numeric) ? fallback : numeric;
}

function toNullableNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

function nowIso() {
  return new Date().toISOString();
}

function getSettingValue(key, fallback) {
  const row = settingByKeyStmt.get(key);
  return row ? String(row.value) : fallback;
}

function getSettingInt(key, fallback = 0) {
  return toNumber(getSettingValue(key, String(fallback)), fallback);
}

function bumpControlVersion() {
  const next = getSettingInt('control_version', 0) + 1;
  upsertSettingStmt.run('control_version', String(next));
  return next;
}

function getControlState() {
  const pumpTarget = parseBoolean(getSettingValue('pump_target_state', '0')) ?? false;
  const pumpActual = parseBoolean(getSettingValue('pump_actual_state', pumpTarget ? '1' : '0')) ?? getPumpStatus();
  const pumpCommandVersion = getSettingInt('pump_command_version', 0);
  const pumpAckVersion = getSettingInt('pump_ack_version', 0);

  const servoTarget = getSettingValue('servo_target_crop', getSettingValue('crop', 'Tomato'));
  const servoActual = getSettingValue('servo_actual_crop', getSettingValue('crop', 'Tomato'));
  const servoCommandVersion = getSettingInt('servo_command_version', 0);
  const servoAckVersion = getSettingInt('servo_ack_version', 0);

  return {
    control_version: getSettingInt('control_version', 0),
    pump: {
      target_state: pumpTarget,
      actual_state: pumpActual,
      command_version: pumpCommandVersion,
      ack_version: pumpAckVersion,
      pending: pumpAckVersion < pumpCommandVersion,
      issued_at: getSettingValue('pump_command_issued_at', ''),
      acked_at: getSettingValue('pump_command_ack_at', '')
    },
    servo: {
      target_crop: servoTarget,
      actual_crop: servoActual,
      command_version: servoCommandVersion,
      ack_version: servoAckVersion,
      pending: servoAckVersion < servoCommandVersion,
      issued_at: getSettingValue('servo_command_issued_at', ''),
      acked_at: getSettingValue('servo_command_ack_at', '')
    }
  };
}

function issuePumpCommand(targetState, source = 'dashboard') {
  const version = bumpControlVersion();
  const issuedAt = nowIso();
  upsertSettingStmt.run('pump_target_state', targetState ? '1' : '0');
  upsertSettingStmt.run('pump_command_version', String(version));
  upsertSettingStmt.run('pump_command_issued_at', issuedAt);
  upsertSettingStmt.run('pump_command_source', source);
  return { version, issuedAt };
}

function issueServoCommand(targetCrop, source = 'dashboard') {
  const version = bumpControlVersion();
  const issuedAt = nowIso();
  upsertSettingStmt.run('servo_target_crop', targetCrop);
  upsertSettingStmt.run('servo_command_version', String(version));
  upsertSettingStmt.run('servo_command_issued_at', issuedAt);
  upsertSettingStmt.run('servo_command_source', source);
  return { version, issuedAt };
}

function acknowledgePumpVersion(version) {
  const commandVersion = getSettingInt('pump_command_version', 0);
  const currentAck = getSettingInt('pump_ack_version', 0);
  const nextAck = Math.min(commandVersion, Math.max(currentAck, version));
  if (nextAck > currentAck) {
    upsertSettingStmt.run('pump_ack_version', String(nextAck));
    upsertSettingStmt.run('pump_command_ack_at', nowIso());
  }
}

function acknowledgeServoVersion(version) {
  const commandVersion = getSettingInt('servo_command_version', 0);
  const currentAck = getSettingInt('servo_ack_version', 0);
  const nextAck = Math.min(commandVersion, Math.max(currentAck, version));
  if (nextAck > currentAck) {
    upsertSettingStmt.run('servo_ack_version', String(nextAck));
    upsertSettingStmt.run('servo_command_ack_at', nowIso());
  }
}

function parseBoolean(value) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'on' || normalized === 'yes') return true;
    if (normalized === 'false' || normalized === 'off' || normalized === 'no') return false;
  }
  return null;
}

function insertSensorReading({
  temperature,
  humidity,
  moisture,
  moistureTomato,
  moisturePechay,
  flowMl,
  deviceId
}) {
  const info = isLegacySensorSchema
    ? insertReadingStmt.run({
        timestamp: new Date().toISOString(),
        temperature,
        humidity,
        moisture,
        moisture1_pct: hasLegacyMoisture1Column
          ? (toNullableNumber(moistureTomato) ?? moisture)
          : undefined,
        moisture2_pct: hasLegacyMoisture2Column
          ? toNullableNumber(moisturePechay)
          : undefined,
        moisture_tomato: hasMoistureTomatoColumn
          ? (toNullableNumber(moistureTomato) ?? moisture)
          : undefined,
        moisture_pechay: hasMoisturePechayColumn
          ? toNullableNumber(moisturePechay)
          : undefined,
        flow_ml: flowMl,
        device_id: deviceId || null
      })
    : insertReadingStmt.run({
        temperature,
        humidity,
        moisture,
        moisture_tomato: hasMoistureTomatoColumn
          ? (toNullableNumber(moistureTomato) ?? moisture)
          : undefined,
        moisture_pechay: hasMoisturePechayColumn
          ? toNullableNumber(moisturePechay)
          : undefined
      });

  const inserted = normalizeReading(insertedReadingStmt.get(info.lastInsertRowid));
  broadcast('sensor_update', inserted);
  return inserted;
}

function getFirmwareControlPayload() {
  const cropRow = settingByKeyStmt.get('crop');
  const moistureThresholdRow = settingByKeyStmt.get('moisture_threshold');
  const pulseDurationRow = settingByKeyStmt.get('pulse_duration_min');
  const pwmDutyRow = settingByKeyStmt.get('pwm_duty_cycle');
  const controlState = getControlState();

  const activeCrop = getSettingValue('servo_target_crop', cropRow ? String(cropRow.value) : 'Tomato');
  const moistureOnThreshold = Math.min(
    Math.max(toNumber(moistureThresholdRow ? moistureThresholdRow.value : 30, 30), 0),
    100
  );
  const moistureOffThreshold = Math.min(100, moistureOnThreshold + 35);
  const pwmOnMs = Math.max(1000, Math.round(toNumber(pulseDurationRow ? pulseDurationRow.value : 30, 30) * 60000));

  const dutyCycle = Math.min(
    Math.max(toNumber(pwmDutyRow ? pwmDutyRow.value : 65, 65), 1),
    100
  );

  const pwmOffMs = dutyCycle >= 100
    ? 0
    : Math.max(0, Math.round((pwmOnMs * (100 - dutyCycle)) / dutyCycle));

  return {
    control_version: controlState.control_version,
    pump_command: controlState.pump.target_state,
    pump_command_version: controlState.pump.command_version,
    pump_ack_version: controlState.pump.ack_version,
    moisture_on_threshold: moistureOnThreshold,
    moisture_off_threshold: moistureOffThreshold,
    pwm_on_ms: pwmOnMs,
    pwm_off_ms: pwmOffMs,
    active_crop: activeCrop,
    servo_target_crop: activeCrop,
    servo_command_version: controlState.servo.command_version,
    servo_ack_version: controlState.servo.ack_version
  };
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
    moisture_pechay: row.moisture_pechay,
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
  const crop = String(req.query.crop || '').trim().toLowerCase();

  const rows = db
    .prepare(`${selectSensorSql} WHERE ${tsCol} >= ? ORDER BY id ASC`)
    .all(cutoff)
    .map(normalizeReading);

  const labels = [];
  const data = [];

  for (const row of rows) {
    let value;

    if (crop === 'pechay') {
      value = toNullableNumber(row.moisture_pechay);
    } else if (crop === 'tomato') {
      value = toNullableNumber(row.moisture_tomato ?? row.moisture);
    } else {
      value = toNullableNumber(row.moisture);
    }

    if (value === null) continue;

    labels.push(new Date(row.recorded_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    data.push(+value.toFixed(1));
  }

  return res.status(200).json({
    labels,
    data
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

  const inserted = insertSensorReading({
    temperature,
    humidity,
    moisture,
    moistureTomato: moisture,
    moisturePechay: null,
    flowMl,
    deviceId: req.body.device_id || null
  });

  return res.status(201).json(inserted);
});

app.post('/api/ingest', (req, res) => {
  if (INGEST_API_KEY) {
    const requestKey = String(req.query.key || req.get('X-API-Key') || '');
    if (requestKey !== INGEST_API_KEY) {
      return res.status(401).json({ message: 'Invalid API key.' });
    }
  }

  const latest = normalizeReading(latestReadingStmt.get());

  const moisture1 = toNumber(req.body.moisture1, NaN);
  const moisture2 = toNumber(req.body.moisture2, NaN);
  const derivedMoisture = Number.isNaN(moisture1) || Number.isNaN(moisture2)
    ? (Number.isNaN(moisture1) ? moisture2 : moisture1)
    : (moisture1 + moisture2) / 2;

  const moisture = toNumber(
    req.body.moisture ?? req.body.soil_moisture ?? req.body.soilMoisture ?? req.body.moisture_pct,
    derivedMoisture
  );

  if (Number.isNaN(moisture)) {
    return res.status(400).json({
      message: 'Invalid payload. Required numeric moisture field: moisture (or soil_moisture/moisture1/moisture2).'
    });
  }

  const temperature = toNumber(req.body.temperature ?? req.body.temperature_c, latest ? latest.temperature : 0);
  const humidity = toNumber(req.body.humidity ?? req.body.humidity_pct, latest ? latest.humidity : 0);
  const flowMl = toNumber(req.body.flow_ml, 0);

  insertSensorReading({
    temperature,
    humidity,
    moisture,
    moistureTomato: Number.isNaN(moisture1) ? moisture : moisture1,
    moisturePechay: Number.isNaN(moisture2) ? null : moisture2,
    flowMl,
    deviceId: req.body.device_id || null
  });

  const incomingCrop = typeof req.body.active_crop === 'string' ? req.body.active_crop.trim() : '';
  if (incomingCrop.length > 0) {
    upsertSettingStmt.run('crop', incomingCrop);
    upsertSettingStmt.run('servo_actual_crop', incomingCrop);
  }

  const genericAckVersion = toNumber(req.body.command_ack_version, NaN);
  const incomingServoAckVersion = toNumber(req.body.servo_ack_version, genericAckVersion);
  if (!Number.isNaN(incomingServoAckVersion)) {
    acknowledgeServoVersion(incomingServoAckVersion);
  }

  const incomingPumpAckVersion = toNumber(req.body.pump_ack_version, genericAckVersion);
  if (!Number.isNaN(incomingPumpAckVersion)) {
    acknowledgePumpVersion(incomingPumpAckVersion);
  }

  const incomingPumpState = parseBoolean(req.body.pump_on);
  if (incomingPumpState !== null) {
    const currentPumpState = getPumpStatus();
    if (incomingPumpState !== currentPumpState) {
      setPumpState(incomingPumpState, 'firmware_sync');
      broadcast('pump_update', { pump_on: incomingPumpState });
    }

    upsertSettingStmt.run('pump_actual_state', incomingPumpState ? '1' : '0');

    const desiredPumpState = parseBoolean(getSettingValue('pump_target_state', incomingPumpState ? '1' : '0'));
    if (desiredPumpState !== null && desiredPumpState === incomingPumpState) {
      acknowledgePumpVersion(getSettingInt('pump_command_version', 0));
    }
  }

  const targetServoCrop = getSettingValue('servo_target_crop', getSettingValue('crop', 'Tomato'));
  if (incomingCrop.length > 0 && incomingCrop === targetServoCrop) {
    acknowledgeServoVersion(getSettingInt('servo_command_version', 0));
  }

  broadcast('command_update', getControlState());

  return res.status(200).json(getFirmwareControlPayload());
});

app.get('/api/commands/state', (_req, res) => {
  return res.status(200).json(getControlState());
});

app.post('/api/commands/ack', (req, res) => {
  const pumpAckVersion = toNumber(req.body.pump_ack_version, NaN);
  if (!Number.isNaN(pumpAckVersion)) {
    acknowledgePumpVersion(pumpAckVersion);
  }

  const servoAckVersion = toNumber(req.body.servo_ack_version, NaN);
  if (!Number.isNaN(servoAckVersion)) {
    acknowledgeServoVersion(servoAckVersion);
  }

  const actualPump = parseBoolean(req.body.pump_actual_state);
  if (actualPump !== null) {
    upsertSettingStmt.run('pump_actual_state', actualPump ? '1' : '0');
  }

  if (typeof req.body.servo_actual_crop === 'string' && req.body.servo_actual_crop.trim().length > 0) {
    upsertSettingStmt.run('servo_actual_crop', req.body.servo_actual_crop.trim());
  }

  const state = getControlState();
  broadcast('command_update', state);
  return res.status(200).json(state);
});

app.get('/api/servo/status', (_req, res) => {
  return res.status(200).json(getControlState().servo);
});

app.post('/api/servo/target', (req, res) => {
  const crop = String(req.body.crop || '').trim();
  if (!CROPS[crop]) {
    return res.status(400).json({ message: 'Invalid crop. Expected Tomato or Pechay.' });
  }

  const source = String(req.body.source || 'dashboard');
  const issued = issueServoCommand(crop, source);
  upsertSettingStmt.run('crop', crop);

  const state = getControlState();
  broadcast('command_update', state);

  return res.status(200).json({
    crop,
    command_version: issued.version,
    issued_at: issued.issuedAt,
    pending: state.servo.pending,
    servo: state.servo
  });
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
  const requested = parseBoolean(req.body.state);
  if (requested === null) {
    return res.status(400).json({ message: 'Invalid state. Use true/false or 1/0.' });
  }

  const source = String(req.body.source || 'dashboard');
  const issued = issuePumpCommand(requested, source);
  setPumpState(requested, source);
  upsertSettingStmt.run('pump_actual_state', requested ? '1' : '0');
  acknowledgePumpVersion(issued.version);

  const commandState = getControlState();
  const response = {
    pump_on: requested,
    command_version: issued.version,
    ack_version: commandState.pump.ack_version,
    pending: commandState.pump.pending
  };
  broadcast('pump_update', response);
  broadcast('command_update', commandState);

  return res.status(200).json(response);
});

app.post('/api/pump/manual', (req, res) => {
  const durationMinutes = Math.min(Math.max(toNumber(req.body.duration_minutes, 1), 1), 120);
  const targetCrop = String(req.body.target_crop || getSettingValue('servo_target_crop', getSettingValue('crop', 'Tomato')));

  if (!CROPS[targetCrop]) {
    return res.status(400).json({ message: 'Invalid target_crop. Expected Tomato or Pechay.' });
  }

  const servoIssued = issueServoCommand(targetCrop, 'manual_override');
  const pumpStartIssued = issuePumpCommand(true, 'manual_override_start');

  setPumpState(true, 'manual');
  upsertSettingStmt.run('pump_actual_state', '1');
  acknowledgePumpVersion(pumpStartIssued.version);
  broadcast('pump_update', { pump_on: true });
  broadcast('command_update', getControlState());

  setTimeout(() => {
    const pumpStopIssued = issuePumpCommand(false, 'manual_override_end');
    setPumpState(false, 'manual_end');
    upsertSettingStmt.run('pump_actual_state', '0');
    acknowledgePumpVersion(pumpStopIssued.version);
    broadcast('pump_update', { pump_on: false });
    broadcast('command_update', getControlState());
  }, durationMinutes * 60 * 1000);

  const state = getControlState();
  return res.status(200).json({
    message: `Manual watering started for ${durationMinutes} minute(s).`,
    duration_minutes: durationMinutes,
    target_crop: targetCrop,
    servo_command_version: servoIssued.version,
    pump_command_version: pumpStartIssued.version,
    command_state: state
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
  const latest = normalizeReading(latestReadingStmt.get());
  if (!latest) {
    return res.status(200).json({ heat_stress: 0, evapotranspiration: 0, fungal_risk: 0 });
  }

  const temp = toNumber(latest.temperature, 0);
  const humidity = toNumber(latest.humidity, 0);
  const moisture = toNumber(latest.moisture, 0);

  const heatStress = clampPercent(((temp - 20) / 15) * 100);
  const evapotranspiration = clampPercent(((temp - 10) * 2) + ((100 - humidity) * 0.35));
  const fungalRisk = clampPercent(((humidity - 55) * 1.6) + (moisture > 70 ? 12 : 0));

  return res.status(200).json({
    heat_stress: +heatStress.toFixed(1),
    evapotranspiration: +evapotranspiration.toFixed(1),
    fungal_risk: +fungalRisk.toFixed(1)
  });
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
