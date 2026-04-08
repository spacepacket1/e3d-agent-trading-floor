---
description: Set up ~/.openclaw/openclaw.json for the e3d-agent-trading-floor pipeline
---

# OpenClaw setup for `e3d-agent-trading-floor`

This guide explains how to configure `~/.openclaw/openclaw.json` so the `e3d-agent-trading-floor` `pipeline.js` can load the local Scout, Harvest, Risk, and Executor agent workspaces correctly.

## What `pipeline.js` expects

The pipeline loads agent context from these local subfolders relative to the repo root:

- `scout`
- `harvest`
- `risk`
- `executor`

For each agent, `pipeline.js` reads these files if they exist:

- `AGENTS.md`
- `IDENTITY.md`
- `MEMORY.md`
- `SOUL.md`
- `TOOLS.md`
- `USER.md`

It also calls OpenClaw like this:

```bash
openclaw agent --agent scout --message "..." --json
```

So your OpenClaw config must register those agent IDs and point them at the in-repo folders.

## Where the config lives

The file should be here:

```bash
~/.openclaw/openclaw.json
```

If the file does not exist, create it.

## Required workspace mapping

Make sure the four trading agents map to the repo folders inside `e3d-agent-trading-floor`:

- `scout` → `/Users/mini/e3d-agent-trading-floor/scout`
- `harvest` → `/Users/mini/e3d-agent-trading-floor/harvest`
- `risk` → `/Users/mini/e3d-agent-trading-floor/risk`
- `executor` → `/Users/mini/e3d-agent-trading-floor/executor`

If you keep the repo somewhere else, use that absolute path instead.

## Example config shape

The exact OpenClaw schema can vary by version, but the important part is that each agent entry points to the correct workspace path and keeps `clawd-qwen` separate.

```json
{
  "agents": {
    "scout": {
      "workspace": "/Users/mini/e3d-agent-trading-floor/scout"
    },
    "harvest": {
      "workspace": "/Users/mini/e3d-agent-trading-floor/harvest"
    },
    "risk": {
      "workspace": "/Users/mini/e3d-agent-trading-floor/risk"
    },
    "executor": {
      "workspace": "/Users/mini/e3d-agent-trading-floor/executor"
    },
    "clawd-qwen": {
      "workspace": "/Users/mini/path-to-clawd-qwen"
    }
  }
}
```

If your installed OpenClaw schema uses different keys, keep the same idea:

- preserve the agent IDs
- point each agent to the correct folder
- keep `clawd-qwen` separate
- do not rename the trading agent IDs unless you also update `pipeline.js`

## Minimal validation checklist

After editing `~/.openclaw/openclaw.json`, verify:

- `openclaw agent --agent scout --message "test" --json` works
- `openclaw agent --agent harvest --message "test" --json` works
- `openclaw agent --agent risk --message "test" --json` works
- `openclaw agent --agent executor --message "test" --json` works

Then run the pipeline from the repo root:

```bash
node pipeline.js
```

If the config is correct, the pipeline will be able to load local context from the in-repo agent folders and send agent calls through OpenClaw.

## Notes

- Keep the agent IDs exactly as `scout`, `harvest`, `risk`, and `executor` unless you also change `pipeline.js`.
- The pipeline reads local prompt files from the repo even before OpenClaw is called, so the folders must exist.
- `clawd-qwen` should stay outside the trading stack unless you explicitly decide to wire it in.
