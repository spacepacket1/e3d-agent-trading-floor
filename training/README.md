# Qwen Agent Training

The scout and harvest agents are fine-tuned LoRA adapters on top of
`mlx-community/Qwen2.5-7B-Instruct-4bit` (downgraded from the 14B base
model on 2026-06-11 — see `train_config_scout_v1.yaml.14b_bak` /
`train_config_harvest_v1.yaml.14b_bak` for the prior config), running
locally via MLX on Apple Silicon. This directory contains the training
pipeline. The MLX server, venv, adapters, and training data live in
`/Users/mini/clawd/e3d`.

---

## Prerequisites

**Hardware:** Apple Silicon Mac with at least 24 GB unified memory.
Training peaks at ~9.8 GB; the 7B base model load size has not been
re-measured since the 2026-06-11 downgrade from 14B (previously ~9.5 GB).
Do not run both simultaneously unless the server's model is unloaded
(`model_loaded: false` in `/health`).

**Software:**
```bash
# Python 3.11+ required
cd /Users/mini/clawd/e3d
python3 -m venv .venv
source .venv/bin/activate
pip install mlx-lm flask gunicorn
```

The model weights download automatically on first use from Hugging Face.
`mlx-community/Qwen2.5-7B-Instruct-4bit` is the current base model;
ensure disk space before running.

---

## Directory layout

```
/Users/mini/clawd/e3d/          ← MLX server home (NOT in git)
  mlx_server.py                 ← Flask inference server
  start_gunicorn_scout.sh       ← Start scout server (port 5051)
  start_gunicorn_harvest.sh     ← Start harvest server (port 5052)
  start_gunicorn_7b.sh          ← Start 7B base server (port 5051)
  start_gunicorn.sh             ← Start base server, no adapter (port 5050)
  stop_gunicorn.sh              ← Stop server
  install_cron.sh               ← Install Sunday 3am cron job
  adapters_scout_v1/            ← Scout LoRA weights (produced by training)
  adapters_harvest_v1/          ← Harvest LoRA weights (produced by training)
  data/scout/                   ← Extracted scout training data
  data/harvest/                 ← Extracted harvest training data
  training_runs.jsonl           ← Training run history (loss, duration, status)
  last_training_status.json     ← Result of most recent pipeline run
  logs/cron_train.log           ← Training log

training/                       ← This directory (in git)
  cron_train_agents.sh          ← Weekly training orchestrator (entry point)
  train_scout_adapter.sh        ← Scout fine-tuning pipeline
  train_harvest_adapter.sh      ← Harvest fine-tuning pipeline
  train_config_scout_v1.yaml    ← Scout LoRA hyperparameters
  train_config_harvest_v1.yaml  ← Harvest LoRA hyperparameters
  extract_agent_training_data.py  ← ORPHANED COPY — do not edit. The
                                     adapter shell scripts actually run
                                     the copy in /Users/mini/clawd/e3d/,
                                     which has diverged and is
                                     authoritative. This copy is stale
                                     (last touched 2026-05-13) and not
                                     invoked by anything.
  generate_synthetic_training_data.py  ← Generates synthetic training examples
  split_data.py                 ← Train/valid/test split utility
  smart_truncate.py             ← Prompt truncation utility
```

---

## Starting the inference servers

The app expects the scout adapter on port **5050** and the harvest adapter
on port **5052** by default (overridable via env vars — see below).

```bash
cd /Users/mini/clawd/e3d

# Scout agent (7B + LoRA adapter, port 5051)
./start_gunicorn_scout.sh

# Harvest agent (7B + LoRA adapter, port 5052)
./start_gunicorn_harvest.sh

# Base model only, no adapter (port 5050) — useful for testing
./start_gunicorn.sh

# NOTE: since the base model is now 7B (see top of this doc), the line
# below and the "Scout agent" line above both describe a 7B server —
# this script/port pairing has not been reconciled since the 14B→7B
# switch and may be redundant or stale. Verify against the running
# process before relying on it.
# Alternative: smaller 7B base model (port 5051, no adapter)
./start_gunicorn_7b.sh

# Stop any running server
./stop_gunicorn.sh
```

Check server health:
```bash
curl http://localhost:5050/health
# → {"model_loaded": false, "status": "ok", ...}
# model_loaded becomes true after the first request triggers model load
```

The server is OpenAI-compatible (`POST /v1/chat/completions`). Models are
lazy-loaded on first request, not at startup.

---

## Running training

### Ad-hoc (manual)

```bash
/Users/mini/e3d-agent-trading-floor/training/cron_train_agents.sh
```

The script self-re-execs under `nohup` so closing your terminal won't
kill it. Output goes to `/Users/mini/clawd/e3d/logs/cron_train.log`.

Watch progress live:
```bash
tail -f /Users/mini/clawd/e3d/logs/cron_train.log
```

### Scheduled (twice weekly, Sunday and Wednesday at 3am)

Training does **not** run via cron — it's a **launchd** job,
`com.e3d.train` (`~/Library/LaunchAgents/com.e3d.train.plist`), which
fires Sunday and Wednesday at 3am (more frequent than the historical
"Sunday only" cadence `install_cron.sh` was written for). Check its
status with:

```bash
launchctl list | grep com.e3d.train
launchctl print gui/$(id -u)/com.e3d.train
```

> **Note:** `install_cron.sh` is stale — it predates the switch to
> launchd and references the old script path
> `/Users/mini/clawd/e3d/cron_train_agents.sh` rather than the current
> `/Users/mini/e3d-agent-trading-floor/training/cron_train_agents.sh`.
> Do not use it to (re)install the schedule; edit the `.plist` instead.

### What training does

Each run (scout then harvest, sequentially):

1. Extracts labelled examples from
   `/Users/mini/e3d-agent-trading-floor/logs/training-events.jsonl`
   (all history, no cutoff — full cold retrain each time)
2. Mixes in 300 synthetic examples
3. Splits 90/5/5 into train/valid/test
4. Backs up existing adapter to a timestamped directory
5. Clears the adapter dir (cold retrain from base model weights)
6. Runs `mlx_lm.lora` for 3 full epochs
7. Evaluates test loss; rolls back to backup if loss regresses >5%
8. Appends a result entry to `training_runs.jsonl`

**Runtime:** ~100 min for scout, ~130 min for harvest (~4 hours total).
Memory peaks at ~9.8 GB — do not trigger model loads on the inference
servers during training.

### Training configs

Both agents use identical hyperparameters (`train_config_*_v1.yaml`):

| Parameter | Value |
|-----------|-------|
| Base model | `mlx-community/Qwen2.5-7B-Instruct-4bit` |
| Fine-tune type | LoRA |
| LoRA rank | 8 |
| Epochs | 3 |
| Learning rate | 5e-6 |
| Batch size | 1 |
| Max sequence length | 2048 |
| Gradient checkpointing | enabled |

---

## How the app uses the models

`pipeline.js` calls the MLX server via HTTP using an OpenAI-compatible
request. Key env vars (all optional — defaults shown):

```bash
LLM_BASE_URL=http://127.0.0.1:5050        # Which server to call
LLM_MODEL=mlx-community/Qwen2.5-7B-Instruct-4bit
SCOUT_ADAPTER_PATH=./adapters_scout_v1    # Passed as X-Adapter-Path header
HARVEST_ADAPTER_PATH=./adapters_harvest_v1
```

The scout and harvest adapter paths are sent as an `X-Adapter-Path`
request header. `mlx_server.py` uses this to hot-swap the loaded adapter
between requests (within the same model load).

Tool-calling uses the Qwen native `<tool_call>{...}</tool_call>` XML
format, which `mlx_server.py` converts to OpenAI-style `tool_calls` JSON
before returning to the app.

### After training: reloading the adapter

The running server does not need to be restarted — it reloads adapters
per-request from the path in the header. To pick up new adapter weights
immediately after training completes, the next inference request will
automatically use them.

If you want to verify the new adapter is being used:
```bash
curl http://localhost:5050/health
# Check the "adapter" field matches the expected path
```
