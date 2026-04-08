# Installation

This project is a Node.js trading pipeline plus dashboard with local MongoDB and ClickHouse services.

## Requirements
- Node.js 18+
- npm
- Docker Desktop or another Docker Engine that supports `docker compose`
- A local LLM server running on port 5050 — the pipeline calls `http://127.0.0.1:5050/v1/chat/completions` directly (OpenAI-compatible endpoint). Override with `LLM_BASE_URL` env var.

> The LLM server is **not** bundled in this repo. On the original machine it is a gunicorn-served MLX model at `/Users/mini/clawd/e3d` (`start_gunicorn.sh`). On a new machine point `LLM_BASE_URL` at any OpenAI-compatible server (local or remote).

## Install

Run the installer from the repo root:

```bash
bash ./install.sh
```

Or via npm:

```bash
npm run setup
```

To build a macOS `.pkg` installer:

```bash
npm run package:macos
```

## What the installer does
- Installs JavaScript dependencies with `npm install`
- Starts MongoDB and ClickHouse with Docker Compose
- Runs the pipeline syntax check

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `LLM_BASE_URL` | `http://127.0.0.1:5050` | OpenAI-compatible LLM server base URL |
| `E3D_API_BASE_URL` | `https://e3d.ai/api` | E3D data API base URL |
| `E3D_CLICKHOUSE_HTTP_URL` | `http://127.0.0.1:8123` | ClickHouse HTTP URL |
| `E3D_MONGO_CONTAINER` | `e3d-mongo` | Mongo container name |
| `DEBUG_MODE` | _(unset)_ | Set to `1` for verbose pipeline logging |

## Run the app

Start both services independently:

```bash
# Terminal 1 — dashboard + WebSocket server (port 3000)
npm run dashboard

# Terminal 2 — pipeline loop (calls LLM directly, no openclaw needed)
npm run loop
```

Or start the pipeline once (no loop):

```bash
npm start
```

## macOS package output
- The package builder writes the installer to `dist/macos/E3D-Pipeline.pkg`
- The installed app lands in `/Applications/E3D Pipeline`
- The installer includes launchers for the dashboard and the pipeline loop

## Notes
- The pipeline agents (scout, harvest, risk, executor) call the LLM directly via `LLM_BASE_URL` — no openclaw CLI is needed in the hot path.
- The `logs/` directory is created automatically on first run.
- `portfolio.json` starts empty on a fresh clone (paper-trade mode by default).
- The repository keeps the E3D agent workspace configs in-repo (`scout/`, `harvest/`, `risk/`, `executor/`).
