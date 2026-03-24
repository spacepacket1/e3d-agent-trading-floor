# Local MongoDB and ClickHouse Stack

This project uses Docker Compose to run MongoDB for portfolio state and ClickHouse for append-only training and event data.

## Services
- **MongoDB**
  - Host: `localhost`
  - Port: `27017`
  - Role: live portfolio state, cooldowns, stats, and active references
- **ClickHouse**
  - HTTP port: `8123`
  - Native port: `9000`
  - Role: normalized training/event history and analytics-ready records

## Commands
- Start both services:
  - `npm run db:up`
- Stop both services:
  - `npm run db:down`
- View logs:
  - `npm run db:logs`
- Check service status:
  - `npm run db:ps`

## Data persistence
- MongoDB data is stored in a named Docker volume: `mongo_data`
- ClickHouse data is stored in a named Docker volume: `clickhouse_data`

## Notes
- The pipeline currently still writes training events to `logs/training-events.jsonl` as the normalized event write path.
- MongoDB and ClickHouse are added now so the pipeline can be wired to them next without changing the service layout.
