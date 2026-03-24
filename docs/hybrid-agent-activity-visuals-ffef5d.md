---
description: Hybrid dashboard plan for visualizing agent activity without raw logs
---
# Hybrid Agent Activity Visualization Plan

Create a hybrid activity area that replaces raw log-like rows with a compact Scout → Harvest → Risk → Executor flow, agent health meters, and grouped milestone badges so the dashboard communicates behavior at a glance.

## Goal
Make the agent-activity section feel like an operations console rather than a log viewer, while still preserving the underlying event data for drill-down and debugging.

## Proposed layout
1. **Flow strip**
   - Show Scout, Harvest, Risk, and Executor as connected stages.
   - Each stage should surface its current status, recent decision count, and last updated time.
   - Use directional arrows or connectors so the decision chain reads left to right.

2. **Agent health meters**
   - Under the flow strip, show small metric cards for each agent.
   - Suggested values: approvals, rejections, paper-trades, blockers, and last cycle age.
   - Use color and progress-style bars to indicate momentum or friction.

3. **Milestone badges**
   - Replace raw event rows with grouped visual badges.
   - Examples: candidate surfaced, harvest exit flagged, risk approved, executor deferred, trade opened, trade closed, regime changed.
   - Add short contextual labels rather than full payload dumps.

4. **Optional detail drawer**
   - Keep deeper event details available on click.
   - Show a compact summary, not the full raw JSON, unless explicitly expanded.

## Data mapping
- Use existing `/api/summary` data for counts and recent activity.
- Derive per-agent status from event types and latest timestamps.
- Convert training events into grouped display items by cycle, candidate, and trade id.
- Keep the raw APIs intact for debugging, but do not emphasize them in the default dashboard view.

## UX notes
- Favor quick scanning over dense text.
- Make the hybrid section visually balanced with the open positions panel.
- Keep the current dark, glassy design language.
- Preserve mobile responsiveness by stacking the flow, meters, and badges vertically.

## Rollout steps
1. Confirm the exact hybrid visual language with the user.
2. Add the new derived activity model in the dashboard client.
3. Replace the current activity snapshot with the flow strip, meters, and milestone badges.
4. Test the layout at desktop and mobile widths.
5. Fine-tune copy and colors based on the user’s feedback.
