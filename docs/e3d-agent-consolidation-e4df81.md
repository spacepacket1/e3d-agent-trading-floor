# E3D Agent Consolidation Plan

Consolidate the current Scout, Risk, and Executor agent workspaces into `e3d-agent-trading-floor`, keep `clawd-qwen` separate in OpenClaw, and extend `pipeline.js` with the next planned market-regime layer while preserving the existing paper-trading-first flow.

## Scope
- Move the agent prompt/spec files for Scout, Risk, and Executor into the `e3d-agent-trading-floor` repo so the full trading system can be checked into GitHub as one project.
- Keep `clawd-qwen` as a separate workspace, but leave its OpenClaw presence intact in `openclaw.json`.
- Preserve the current deterministic simulation architecture in `pipeline.js` and add the market regime filter as the next feature in the existing execution order.

## Proposed Phases
1. **Inventory and mapping**
   - Document every file in the three agent workspaces that is part of the runtime contract: AGENTS, SOUL, TOOLS, IDENTITY, USER, MEMORY, and any bootstrap files.
   - Map how `openclaw.json` currently binds agent IDs, workspaces, models, and tool permissions.
   - Identify which pieces of the current `pipeline.js` behavior depend on the separate workspaces versus only on prompt content.

2. **Repo consolidation**
   - Create an in-repo agent layout inside `e3d-agent-trading-floor` that mirrors the current Scout/Risk/Executor separation.
   - Move or recreate the agent instructions so the system remains functionally equivalent after consolidation.
   - Update any paths or references needed so the Node pipeline can call the local agent assets cleanly.

3. **OpenClaw wiring and compatibility**
   - Update OpenClaw configuration or related workspace metadata so the in-repo agents are the primary trading stack.
   - Keep the `clawd-qwen` agent entry untouched except for any non-disruptive reference updates required by the new layout.
   - Verify that agent IDs, prompts, and tool allow/deny boundaries still reflect the intended Scout/Risk/Executor roles.

4. **Market regime filter implementation**
   - Add the regime classifier into `pipeline.js` at the point the spec defines, before buy/rotation decisions.
   - Define the regime inputs from existing scout/risk/portfolio state first, then gate buy behavior according to `risk_on`, `neutral`, and `risk_off`.
   - Keep the filter deterministic and log its output alongside the rest of the pipeline stages.

5. **Validation and rollout**
   - Run paper-mode scenarios to confirm portfolio state, sell logic, rotation, and buy constraints still behave deterministically.
   - Confirm the migrated agents still emit and consume the expected JSON shapes.
   - Document the final file layout and the rollout order so the repository can be safely checked into GitHub.

## Risks and constraints
- Do not redesign the system beyond the spec: extend the current pipeline rather than replacing it.
- Keep paper-trading as the default operating mode.
- Avoid breaking `openclaw.json` bindings for `clawd-qwen` while consolidating the E3D trading stack.
- Preserve the current logging and portfolio state semantics so simulation output remains comparable before and after the move.
