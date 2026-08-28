# Feature Ticket: E3D Agent Verdicts UI

**Project:** E3D main repo — UI surface for agent verdicts and outcomes  
**Feature:** Display `E3DAgentActions` and `E3DAgentOutcomes` data in the E3D UI  
**Depends on:** `e3d-action-outcome-export-feature-ticket.md` (exporter must run first)  
**Target repo:** `/Users/mini/e3d` (E3D main repo)

**Primary new files:**

```text
server/agentVerdictRoutes.js
client/src/AgentVerdictsPage.js
client/src/AgentVerdictCard.js
```

**Files to modify:**

```text
server/spacepacket.js           — register new routes
client/src/App.js               — add route /agent-verdicts
client/public/e3d_decision_layer_paper_v1.md   — add link to /agent-verdicts
client/public/e3d_decision_layer_paper_v1.html — add link to /agent-verdicts
```

**Status:** Ready for implementation  
**Priority:** High  
**Goal:** Expose the E3D Agent Verdict Engine output in the E3D UI.

---

## 1. Executive Summary

The exporter (`scripts/e3dActionOutcomeExport.js` in `e3d-agent-trading-floor`) continuously writes agent verdicts and outcomes into the AWS ClickHouse tables `E3DAgentActions` and `E3DAgentOutcomes`. This ticket creates the Express API routes and React page that read from those tables and display them in the E3D UI.

The new page lives at `/agent-verdicts`. It shows:

- Summary stats: verdicts reviewed, paper buys, rejections, validated outcomes, win rate
- A filterable list of agent verdicts (approved buys, rejected candidates, exits)
- Outcome details for verdicts that have been tracked

---

## 2. Data Source

All data comes from two AWS ClickHouse tables written by the exporter.

### `E3DAgentActions`

One row per agent verdict. Key fields used in this UI:

```text
action_id          String
created_at         DateTime64(3)
updated_at         DateTime64(3)
token_address      String
symbol             String
chain              LowCardinality(String)
action_type        LowCardinality(String)  — PAPER_BUY | PAPER_SELL | REJECT | WAIT | PAPER_EXIT
agent_decision     LowCardinality(String)  — paper_trade | reject | wait
simulated_side     LowCardinality(String)  — buy | sell | none
market_regime      LowCardinality(String)
actor              LowCardinality(String)
confidence_score   Float64
risk_score         Float64
entry_price        Float64
allocation_usd     Float64
liquidity_usd      Float64
thesis_summary     String
reason_summary     String
reject_reason      String
trade_id           String
position_id        String
candidate_id       String
```

### `E3DAgentOutcomes`

One row per paper trade or realized outcome. Key fields:

```text
outcome_id        String
action_id         String
measured_at       DateTime64(3)
token_address     String
symbol            String
outcome_type      LowCardinality(String)   — paper_trade | realized_outcome
outcome_window    LowCardinality(String)   — trade | realized
outcome_label     LowCardinality(String)   — buy | sell | profit | loss
verdict           LowCardinality(String)   — recorded | validated | invalidated
entry_price       Float64
exit_price        Float64
current_price     Float64
pnl_usd           Float64
pnl_pct           Float64
holding_days      Float64
```

---

## 3. Express API Routes

Create `server/agentVerdictRoutes.js` as a modular route file following the same pattern as `server/tokenIntelligenceRoutes.js` and `server/agentRoutes.js`.

### 3.1 Module signature

```js
async function registerAgentVerdictRoutes(app, deps) {
  const { clickhouse, escapeCH } = deps;

  async function chQ(q) {
    return await clickhouse.query(q).toPromise();
  }

  // ... route definitions ...
}

module.exports = { registerAgentVerdictRoutes };
```

`module.exports` must be at the **bottom of the file**, outside the function body.

### 3.2 Endpoints

#### `GET /agent-verdicts/summary`

Returns summary stats for the past 7 days.

```js
// No auth required — public stats
app.get('/agent-verdicts/summary', async (req, res) => {
  const rows = await chQ(`
    SELECT
      action_type,
      simulated_side,
      count() AS count
    FROM E3DAgentActions FINAL
    WHERE created_at >= now() - INTERVAL 7 DAY
    GROUP BY action_type, simulated_side
    ORDER BY count DESC
  `);
  // Also query win rate from outcomes:
  const outcomeRows = await chQ(`
    SELECT
      verdict,
      count() AS count
    FROM E3DAgentOutcomes FINAL
    WHERE measured_at >= now() - INTERVAL 30 DAY
      AND outcome_type = 'realized_outcome'
    GROUP BY verdict
  `);
  return res.json({ generated_at: new Date().toISOString(), actions: rows || [], outcomes: outcomeRows || [] });
});
```

#### `GET /agent-verdicts`

Returns filtered list of agent verdicts, most recent first.

Query params:
- `limit` (default 50, max 200)
- `offset` (default 0)
- `action_type` — filter by action_type (e.g. `PAPER_BUY`, `REJECT`)
- `simulated_side` — `buy`, `sell`, `none`
- `market_regime` — e.g. `risk_off`
- `since` — ISO timestamp

```js
app.get('/agent-verdicts', async (req, res) => {
  const limit  = Math.min(Math.max(parseInt(req.query.limit,  10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const actionType    = req.query.action_type    ? String(req.query.action_type).trim()    : '';
  const simulatedSide = req.query.simulated_side ? String(req.query.simulated_side).trim() : '';
  const marketRegime  = req.query.market_regime  ? String(req.query.market_regime).trim()  : '';
  const since         = req.query.since          ? String(req.query.since).trim()          : '';

  const clauses = [];
  if (actionType)    clauses.push(`action_type = '${escapeCH(actionType)}'`);
  if (simulatedSide) clauses.push(`simulated_side = '${escapeCH(simulatedSide)}'`);
  if (marketRegime)  clauses.push(`market_regime = '${escapeCH(marketRegime)}'`);
  if (since)         clauses.push(`created_at >= parseDateTimeBestEffort('${escapeCH(since)}')`);
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';

  const rows = await chQ(`
    SELECT
      action_id, created_at, token_address, symbol, chain,
      action_type, agent_decision, simulated_side, market_regime,
      confidence_score, risk_score, entry_price, allocation_usd,
      thesis_summary, reason_summary, reject_reason,
      trade_id, candidate_id
    FROM E3DAgentActions FINAL
    ${where}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return res.json({ verdicts: rows || [], limit, offset });
});
```

#### `GET /agent-verdicts/:actionId/outcome`

Returns outcomes for a given action_id.

```js
app.get('/agent-verdicts/:actionId/outcome', async (req, res) => {
  const actionId = String(req.params.actionId || '').trim();
  if (!actionId) return res.status(400).json({ message: 'actionId required' });

  const rows = await chQ(`
    SELECT *
    FROM E3DAgentOutcomes FINAL
    WHERE action_id = '${escapeCH(actionId)}'
    ORDER BY measured_at DESC
    LIMIT 10
  `);

  return res.json({ outcomes: rows || [] });
});
```

**Note on `action_id` type:** Unlike `E3DActions` (which uses `toUUID()`), `E3DAgentActions` stores `action_id` as a `String` (SHA-256 hex). Use plain string comparison, not `toUUID()`.

### 3.3 Register the routes in `spacepacket.js`

This requires changes in **two separate locations** in `spacepacket.js`.

**Location 1 — top of file, near lines 39–41** (where the other route files are required):

```js
// existing lines already there:
const { registerPcapRoutes } = require('./pcapRoutes');
const { registerAgentRoutes } = require('./agentRoutes');
const { registerTokenIntelligenceRoutes } = require('./tokenIntelligenceRoutes');
// add this line:
const { registerAgentVerdictRoutes } = require('./agentVerdictRoutes');
```

**Location 2 — near lines 3279–3310** (where the route registration calls are made):

```js
registerAgentVerdictRoutes(app, {
  clickhouse,
  escapeCH,
});
```

---

## 4. React Page: `AgentVerdictsPage.js`

Create `/Users/mini/e3d/client/src/AgentVerdictsPage.js`.

Style: match `ActionsPage.js` exactly — same `makeStyles`, same color palette (`#e5e7ff`, `#9ea4d8`, `#4d79ff`, `#9ef7c5`, `#ff4d6a`), same dark background.

### 4.1 Layout

```
AgentVerdictsPage
├── Page title: "Agent Verdicts"
├── Page subtitle: (see product language below)
├── SummaryCards
│   ├── Reviewed (7d)
│   ├── Paper Buys
│   ├── Rejections
│   ├── Validated Outcomes
│   └── Win Rate
├── FiltersRow
│   ├── Action Type select (PAPER_BUY | PAPER_SELL | REJECT | WAIT | All)
│   ├── Side select (buy | sell | none | All)
│   └── Clear filters chip
├── Loading spinner | empty state | verdict list
│   └── AgentVerdictCard per row
└── (no pagination in v1 — just limit=50)
```

### 4.2 State

```js
const [summary, setSummary] = useState(null);
const [verdicts, setVerdicts] = useState([]);
const [outcomes, setOutcomes] = useState({});   // keyed by action_id
const [loading, setLoading] = useState(true);
const [actionTypeFilter, setActionTypeFilter] = useState('');
const [sideFilter, setSideFilter] = useState('');
```

### 4.3 API calls

```js
// Summary (once on mount)
fetch(`${API_BASE}/agent-verdicts/summary`)
  .then(r => r.json()).then(setSummary).catch(() => {});

// Verdict list (on filter change)
const params = new URLSearchParams({ limit: 50 });
if (actionTypeFilter) params.set('action_type', actionTypeFilter);
if (sideFilter)       params.set('simulated_side', sideFilter);
fetch(`${API_BASE}/agent-verdicts?${params}`)
  .then(r => r.json())
  .then(data => { setVerdicts(data.verdicts || []); setLoading(false); })
  .catch(() => setLoading(false));

// Outcomes for verdicts that have a trade_id (fetch after verdicts load)
// Same pattern as ActionsPage.js lines 166-181
```

### 4.4 SummaryCards helper

Derive from the `summary` response:

```js
const totalReviewed = (summary.actions || []).reduce((s, r) => s + Number(r.count), 0);
const paperBuys     = (summary.actions || []).filter(r => r.action_type === 'PAPER_BUY').reduce((s,r) => s+Number(r.count), 0);
const rejections    = (summary.actions || []).filter(r => r.action_type === 'REJECT').reduce((s,r) => s+Number(r.count), 0);
const validated     = (summary.outcomes || []).filter(r => r.verdict === 'validated').reduce((s,r) => s+Number(r.count), 0);
const invalidated   = (summary.outcomes || []).filter(r => r.verdict === 'invalidated').reduce((s,r) => s+Number(r.count), 0);
const winRate       = (validated + invalidated) > 0
  ? Math.round((validated / (validated + invalidated)) * 100) + '%'
  : '—';
```

---

## 5. React Component: `AgentVerdictCard.js`

Create `/Users/mini/e3d/client/src/AgentVerdictCard.js`.

Model it on `ActionCard.js` (collapsible pattern using MUI `Collapse`):

### 5.1 Collapsed view (always visible)

```
[action_type chip]  [symbol]  [simulated_side]  [confidence_score]  [created_at]
```

- `action_type` chip colors: `PAPER_BUY` → green (`#9ef7c5`), `PAPER_SELL` → red (`#ff4d6a`), `REJECT` → gray (`#9ea4d8`), `WAIT` → dim yellow
- `confidence_score` displayed as a number (e.g. `0.74`)
- `created_at` formatted as relative time or short date

### 5.2 Expanded view (on click)

Reveal:

```
thesis_summary (if non-empty)
reason_summary
reject_reason (if non-empty, highlighted in amber)
entry_price / allocation_usd / risk_score / liquidity_usd
market_regime
trade_id (if non-empty, short-truncated)

Outcomes section (if outcomes loaded for this action_id):
  per outcome: outcome_type | verdict | pnl_usd | pnl_pct | holding_days
```

Expansion state managed with `useState(false)` per card, toggled via `onClick` on the collapsed row. Use `Collapse` from `@material-ui/core` for the animated expand.

---

## 6. App.js Route

Add one import and one route to `/Users/mini/e3d/client/src/App.js`.

### Import (add near line 81 where `ActionsPage` is imported):

```js
import AgentVerdictsPage from './AgentVerdictsPage';
```

### Route (add near line 16330 where `ActionsPage` route is defined):

```jsx
<Route path="/agent-verdicts" element={<AgentVerdictsPage />} />
```

---

## 7. Paper File Updates

Add a link to `/agent-verdicts` in both paper files. These are static files served from `client/public/`.

### 7.1 `client/public/e3d_decision_layer_paper_v1.md`

Find the last section (around line 686–697, the conclusion paragraph). Append the following after the final paragraph:

```markdown
## Live Implementation

The E3D Decision Layer is now live. Agent verdicts and outcomes produced by the E3D Agent Verdict Engine are visible at [/agent-verdicts](/agent-verdicts).
```

### 7.2 `client/public/e3d_decision_layer_paper_v1.html`

Find the corresponding location in the HTML (the same closing section). Add after the final `</p>` before `</body>`:

```html
<h2 id="live-implementation">Live Implementation</h2>
<p>The E3D Decision Layer is now live. Agent verdicts and outcomes produced by the E3D Agent Verdict Engine are visible at <a href="/agent-verdicts">/agent-verdicts</a>.</p>
```

---

## 8. Product Language

Use on page subtitle and in comments:

```text
E3D does not just detect on-chain structure. It tests whether that structure survives
capital-aware reasoning — and then measures what happens next.
```

Avoid: "trading bot", "buy/sell recommendations", "automatic trading".  
Prefer: "agent verdicts", "simulated actions", "paper execution", "outcome tracking", "capital-aware reasoning".

**Page title:** `Agent Verdicts`  
**Page subtitle:** `Simulated capital decisions produced by the E3D Agent Verdict Engine — approved buys, rejected candidates, and tracked outcomes.`

---

## 9. Acceptance Criteria

1. `GET /agent-verdicts/summary` returns action counts and outcome verdicts without error.
2. `GET /agent-verdicts` returns up to 50 rows, filterable by `action_type` and `simulated_side`.
3. `GET /agent-verdicts/:actionId/outcome` returns outcomes for the given action.
4. `/agent-verdicts` renders in the browser without errors.
5. Summary cards show real counts derived from the summary response.
6. Filtering by action type and side triggers a new API fetch and updates the list.
7. Each `AgentVerdictCard` expands on click to reveal thesis, reason, and outcomes.
8. Paper files link to `/agent-verdicts`.

---

## 10. Non-Goals

Do not modify `ActionsPage.js` or `ActionCard.js`.

Do not create a tab on the existing Decision Layer Actions page — create a standalone `/agent-verdicts` page.

Do not add pagination in v1 — limit=50 with filters is sufficient.

Do not add a nav sidebar entry in this ticket — the page is linked from the paper files and can be accessed directly.

Do not modify any MongoDB models or Mongoose schemas.

---

## 11. Implementation Notes for AI Agent

Read these notes before writing any code. Do not deviate from the verified facts below.

### 11.1 Repo structure

```
/Users/mini/e3d/
├── client/                      — React app (CRA + craco)
│   └── src/
│       ├── App.js               — router, 16,000+ lines; routes start near line 16179
│       ├── ActionsPage.js       — reference page to model style after (263 lines)
│       ├── ActionCard.js        — reference card component to model after
│       └── config.js            — exports SERVER_NAME (API base URL)
└── server/
    ├── spacepacket.js           — main Express server; route registrations at lines 3279–3310
    ├── agentRoutes.js           — example modular route file
    └── tokenIntelligenceRoutes.js — example modular route file
```

### 11.2 Framework: React + Express (not Next.js)

- Client: Create React App + craco, React 18, Material-UI v4, react-router-dom v6
- Server: Express 4, no TypeScript
- Client API calls use `fetch`, not axios
- API base URL: import `SERVER_NAME` from `./config` in all client components
- **Do not use Next.js patterns** (no `getServerSideProps`, no `pages/`, no `app/`)

### 11.3 ClickHouse query pattern in routes

The `clickhouse` object is passed as a dep from `spacepacket.js`. Call it as:

```js
const rows = await clickhouse.query(sqlString).toPromise();
```

There is a retry wrapper (`chQuery`) defined at line 1130 of `spacepacket.js`, but it is not exported. In new route files, either:
- call `clickhouse.query(q).toPromise()` directly (acceptable for first version), or
- accept `chQuery` as an additional dep in `registerAgentVerdictRoutes(app, deps)`

Use `escapeCH(value)` for all user-supplied string values interpolated into SQL. It is passed as a dep.

### 11.4 `action_id` type in E3DAgentActions

`E3DAgentActions.action_id` is a **SHA-256 hex string** stored as `String`, not a UUID. Do **not** use `toUUID()` when querying it. Correct:

```sql
WHERE action_id = '${escapeCH(actionId)}'
```

Wrong (will fail):

```sql
WHERE action_id = toUUID('...')
```

### 11.5 Auth middleware

The `requireAuthJson` middleware is available in spacepacket.js (line 1969). In v1, the agent verdicts endpoints do **not** require auth — the data is public aggregate output, same as `/actions/summary`. Do not add `requireAuthJson` unless explicitly requested.

### 11.6 Route registration pattern in spacepacket.js

Existing registrations at lines 3279–3310:

```js
registerPcapRoutes(app, { clickhouse, requireAuthenticatedJson, ... });
registerTokenIntelligenceRoutes(app, { clickhouse, fetchEthNameRow, escapeCH });
registerAgentRoutes(app, { clickhouse, requireAuthJson, requireAdminJson, ... });
registerAgentVerdictRoutes(app, { clickhouse, escapeCH });
```

The `require` for the new file goes at the **top of spacepacket.js** alongside lines 39–41. The registration call goes in this block. Do not place either in the middle of the 11,000-line file.

### 11.7 Material-UI component imports

Use Material-UI v4 imports (already installed):

```js
import { makeStyles } from '@material-ui/core/styles';
import { Typography, Chip, CircularProgress, Collapse, FormControl, InputLabel, Select, MenuItem } from '@material-ui/core';
```

Do not import from `@mui/material` (v5) — that package is not installed.

### 11.8 Color palette (must match existing pages)

```js
// Background
'rgba(10, 14, 30, 0.92)'         // card background
// Text
'#e5e7ff'                        // primary text
'#9ea4d8'                        // secondary text / labels
// Accent
'#4d79ff'                        // primary accent (borders, spinners)
'rgba(77,121,255,0.22)'          // border color
// Status
'#9ef7c5'                        // positive / validated / paper buy
'#ff4d6a'                        // negative / invalidated / paper sell / failed
```

### 11.9 React imports in client/src files

Client files use **default export** and **named imports** from React:

```js
import React, { useEffect, useState, useCallback } from 'react';
```

### 11.10 App.js import location

ActionsPage import is at line 81 of App.js. Add AgentVerdictsPage import on the next line (line 82). The route for ActionsPage is at line 16330 — add the AgentVerdictsPage route immediately after:

```jsx
<Route path="/actions" element={<ActionsPage />} />
<Route path="/agent-verdicts" element={<AgentVerdictsPage />} />
```

### 11.11 Paper files format

`e3d_decision_layer_paper_v1.md` is raw Markdown. `e3d_decision_layer_paper_v1.html` is a rendered HTML document. Both are static files — no React, no server rendering. Add the link at the **end of the document body**, before the final closing tags. In the HTML file the closing structure is `</body></html>`.

### 11.12 E3DAgentActions table location

All tables — including `E3DAgentActions` and `E3DAgentOutcomes` — are in the **default database**. Do not prefix table names with `e3d.`. Correct:

```sql
FROM E3DAgentActions FINAL
FROM E3DAgentOutcomes FINAL
```

This is consistent with the existing `E3DActions` and `E3DOutcomes` tables already used in the codebase.

### 11.13 The exporter script

The data these pages display is written by:

```text
/Users/mini/e3d-agent-trading-floor/scripts/e3dActionOutcomeExport.js
```

That script must be running (via cron or manually) before any data will appear. If the tables are empty during development, the UI should degrade gracefully (empty state, no errors).

### 11.14 Files to read before writing code

In the E3D main repo, read these files first:

1. `/Users/mini/e3d/client/src/ActionsPage.js` — style reference (263 lines, manageable)
2. `/Users/mini/e3d/client/src/ActionCard.js` — card/collapse pattern
3. `/Users/mini/e3d/server/tokenIntelligenceRoutes.js` lines 1–20 and 1555–1563 — module export pattern
4. `/Users/mini/e3d/server/spacepacket.js` lines 3279–3315 — registration block
5. `/Users/mini/e3d/client/src/App.js` lines 79–85 (imports) and lines 16328–16334 (ActionsPage route)

Do not read all of `spacepacket.js` — it is 11,000+ lines. Use targeted line reads.
