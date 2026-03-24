# OpenClaw Agent Map

This document captures the in-repo agent layout for the consolidated E3D trading stack.

## Agent workspaces
- `scout` → `e3d-agent-trading-floor/scout`
- `harvest` → `e3d-agent-trading-floor/harvest`
- `risk` → `e3d-agent-trading-floor/risk`
- `executor` → `e3d-agent-trading-floor/executor`
- `clawd-qwen` remains separate and is not part of this consolidation

## Intent
- Keep Scout, Risk, Executor, and Harvest under a single GitHub-checkable repository.
- Preserve the existing paper-trading-first workflow.
- Leave the qwen workspace present in OpenClaw without folding it into the trading stack.

## Local runtime note
The active OpenClaw config in `~/.openclaw/openclaw.json` should point the E3D trading agents at the subfolders above.
Harvest should also be bound to its own Discord room in that config so exit-watch alerts can be routed separately.
