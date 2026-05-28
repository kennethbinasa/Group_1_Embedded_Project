# AgroSense - Smart Irrigation Dashboard

Group 1 Embedded Systems Project. This app uses an Express + SQLite backend and a browser frontend served by that backend.

## Project Structure

```
Group_1_Embedded_Project/
|- Backend-Embedded/
|  |- server.js
|  |- agrosense.db
|  `- package.json
|- Frontend-Embedded/
|  |- index.html
|  `- assets/
|     |- css/style.css
|     `- js/app.js
|- package.json
`- README.md
```

## Requirements

- Node.js 18+
- npm

## Install Dependencies

```bash
cd Backend-Embedded
npm install
```

## Run the Website (Updated Frontend + Backend)

### Option A (from project root)

```bash
npm start
```

### Option B (from backend folder)

```bash
cd Backend-Embedded
npm start
```

By default, server runs at:

```
http://localhost:3000
```

Open that URL in your browser. The backend serves the updated frontend files directly, so no separate frontend server is needed.

## Use a Different Port (Optional)

If port 3000 is busy:

```bash
PORT=3100 npm start --prefix Backend-Embedded
```

Then open:

```
http://localhost:3100
```

## Send Test Sensor Data

Use this to verify live dashboard updates:

```bash
curl -X POST http://localhost:3000/api/data \
	-H "Content-Type: application/json" \
	-d '{"temperature":27.5,"humidity":62.2,"soil_moisture":38.4}'
```

PowerShell:

```powershell
Invoke-RestMethod http://localhost:3000/api/data `
	-Method Post `
	-ContentType "application/json" `
	-Body '{"temperature":27.5,"humidity":62.2,"soil_moisture":38.4}'
```

## Key Endpoints

- `GET /health`
- `GET /api/sensors/latest`
- `POST /api/data`
- `GET /api/sensors/moisture/history?hours=24`
- `GET /api/sensors/moisture/weekly-average`
- `POST /api/pump/toggle`
- `POST /api/pump/manual`
- `GET /api/commands/state`
- `POST /api/commands/ack`
- `GET /api/servo/status`
- `POST /api/servo/target`
- `GET /api/settings`
- `POST /api/settings/crop`

## Manual Target Workflow (Servo + Pump)

- Frontend manual override now selects a target crop (`Tomato` or `Pechay`) and sends:
  - `POST /api/servo/target` with `{ crop, source }`
  - `POST /api/pump/manual` with `{ duration_minutes, target_crop }`
- Backend responds with command versions so firmware can reconcile race conditions.

## Firmware Control Versioning (CAP-Safer Control Path)

Each command now carries version metadata:

- `control_version`
- `pump_command_version`, `pump_ack_version`
- `servo_command_version`, `servo_ack_version`

Firmware may acknowledge applied commands by sending one or more of:

- `command_ack_version`
- `pump_ack_version`
- `servo_ack_version`

on `POST /api/ingest`.

The backend keeps target vs. actual state in `/api/commands/state` to avoid silent UI/firmware divergence.

## ETL Pipeline (Telemetry + Commands)

1. Extract:
	- ESP32 sends telemetry and command acknowledgements to `POST /api/ingest` every sync cycle.
2. Transform:
	- Backend normalizes moisture channels (`moisture1`/`moisture2`), computes aggregate moisture, and computes comfort metrics.
	- Command versions are incremented and pending/acknowledged state is derived.
3. Load:
	- Sensor rows are persisted in SQLite for local use.
	- Command target/ack metadata is persisted in `settings` for reconciliation.
	- Realtime updates are broadcast via WebSocket.

## CAP Strategy

- Telemetry path: prioritize Availability + Partition tolerance (eventual consistency acceptable for dashboard readings).
- Control path: prioritize Consistency for actuator commands (versioned target/ack state, explicit reconciliation).
- Result: safer behavior during temporary network partitions or delayed firmware sync cycles.

## Production Deployment Split

### Frontend (Vercel)

- Deploy `Frontend-Embedded/` as a static site.
- `Frontend-Embedded/vercel.json` is included.
- Set runtime API base in `Frontend-Embedded/assets/js/runtime-config.js`:

```js
window.AGROSENSE_API_BASE = 'https://your-backend-domain.example.com';
```

### Backend (Stateful Service)

- Keep backend on a stateful host (Render/Fly/Railway/ECS), not Vercel serverless.
- Included files:
  - `Backend-Embedded/Dockerfile`
  - `Backend-Embedded/render.yaml` (service + managed PostgreSQL + Redis blueprint)

### Managed Data + Realtime (Production)

- Managed database (PostgreSQL) for durable writes.
- Managed realtime broker (Redis/pubsub + websocket gateway) for fanout.
- Keep `/health` checks and ingest API key (`INGEST_API_KEY`) in production.

## Stop Server

Press `Ctrl + C` in the running terminal.
