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
- `GET /api/settings`
- `POST /api/settings/crop`

## Stop Server

Press `Ctrl + C` in the running terminal.
