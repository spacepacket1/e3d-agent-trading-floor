# Installation

This project is a Node.js trading pipeline plus dashboard with local MongoDB and ClickHouse services.

## Requirements
- Node.js 18+
- npm
- Docker Desktop or another Docker Engine that supports `docker compose`
- `openclaw` on your `PATH` for running the trading agents

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
- Warns if the `openclaw` CLI is missing

## Run the app
- Dashboard: `npm run dashboard`
- Pipeline once: `npm start`
- Pipeline loop: `npm run loop`

## macOS package output
- The package builder writes the installer to `dist/macos/E3D-Pipeline.pkg`
- The installed app lands in `/Applications/E3D Pipeline`
- The installer includes launchers for the dashboard and the pipeline loop

## Notes
- The installer does **not** change your OpenClaw configuration.
- The repository keeps the E3D trading agent workspaces in-repo for check-in.
- `clawd-qwen` stays separate and is not folded into this installer.
