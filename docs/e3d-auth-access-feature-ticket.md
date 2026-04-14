---
description: Detailed feature ticket for adding e3d.ai account and API-key authentication to the trading floor app
---
# e3d.ai Auth Access Feature Ticket

Add authenticated e3d.ai access to the E3D agent trading floor so the app can use either a username/password login or an API key, persist the resulting credentials safely outside the browser, and route every e3d.ai request through the authenticated server-side client.

## Background
The trading floor currently consumes several e3d.ai surfaces anonymously. That works for development, but non-subscribers are capped and the agents can only see a small number of stories/theses. The trading app and e3d.ai are separate products, so the fix should not merge their codebases; instead, the trading floor should become a client of authenticated e3d.ai access.

The repository already has two important characteristics that shape this feature:

- The Node server already owns a number of backend responsibilities, including local state, pipeline lifecycle, and some e3d.ai fetches.
- The dashboard is a browser UI served by the Node app, so the UI can submit auth input to the server without storing sensitive material in the browser.

This feature should preserve the paper-trading-first workflow and the deterministic pipeline logic. The only change is how the app authenticates to e3d.ai and retrieves data.

## Problem Statement
Anonymous e3d.ai access is not sufficient for the trading floor because the agents are limited to a small number of stories and theses. The app needs a way to authenticate with e3d.ai using either:

- a username and password login, or
- an API key

Once authenticated, the trading floor should use that identity for all applicable e3d.ai requests so Scout, Harvest, Risk, and the dashboard can work against the full data surface instead of the anonymous limit.

## Goals
- Provide a dashboard UI for entering e3d.ai username/password or API key.
- Authenticate against e3d.ai from the Node server, not from the browser.
- Persist the chosen auth state securely on the local machine.
- Ensure all e3d.ai requests made by the trading floor use the stored auth context.
- Surface auth status clearly in the UI.
- Handle auth failures, expiry, invalid credentials, and manual sign-out cleanly.

## Non-goals
- Do not redesign the trading pipeline.
- Do not migrate the app to a hosted identity provider.
- Do not store secrets in browser `localStorage` or in UI state beyond the current session form.
- Do not change OpenClaw configuration or agent workspaces as part of this ticket.
- Do not add trading strategy changes unrelated to e3d.ai auth.

## Recommended Implementation Approach
Use the Node server as the auth broker, but make **e3d.ai the identity source of truth**.

Preferred order:

1. If the user provides an API key, store and use that.
2. If the user provides username/password, log in through e3d.ai, store the resulting session artifact securely, and use it for future requests.
3. If no credentials are configured, fall back to anonymous access only for explicitly allowed public endpoints.

The browser should never call e3d.ai directly with credentials. It should only talk to the local Node server.

### Identity model decision
- The trading app should **not** introduce its own separate username/password database for this feature.
- The username/password option in the trading app should mean **e3d.ai account login**, not a second trading-floor account.
- In the future, if the trading app is embedded into e3d.ai, the same e3d.ai login/session model can power both experiences without duplicating identity.
- If a lightweight local operator login is ever needed later, it should be a separate follow-up decision and not part of this ticket.

## Files Likely to Change
- `server.js`
- `dashboard/app.js`
- `dashboard/index.html`
- `dashboard/styles.css`
- Potential helper/module extraction if the auth client needs to be shared cleanly
- Any e3d.ai request helper logic inside `pipeline.js` if pipeline-side fetches need the same auth context

## Existing e3d.ai Touchpoints to Audit
These are the current places that should be reviewed and updated so they use authenticated requests where needed:

- `server.js`
  - Token metadata fetches in `fetchTokenMetadata`
  - Any other direct `https://e3d.ai/api/...` fetches
- `pipeline.js`
  - E3D dossier / story / token / webfetch-related requests
  - Any logic that composes E3D API URLs or consumes E3D responses
- `dashboard/app.js`
  - Any links or surfaces that assume anonymous-only data access

## Functional Requirements

### 1. Auth modes
The app must support both of the following auth flows:

- **API key mode**
  - User enters an e3d.ai API key.
  - The server stores it securely.
  - The server uses it on all eligible e3d.ai API requests.

- **Login mode**
  - User enters username and password.
  - The server authenticates against e3d.ai.
  - The server stores the resulting authenticated session securely.
  - The server reuses the session for all eligible e3d.ai API requests.

### 2. UI
Add a dedicated auth panel to the dashboard with:

- A mode selector:
  - `API key`
  - `Username/password`
- Inputs for the selected mode
- A `Connect` / `Save credentials` action
- A `Clear credentials` action
- An auth status indicator with one of:
  - `Not connected`
  - `Connected with API key`
  - `Connected with login session`
  - `Auth expired` / `Auth error`
- A short note explaining that secrets are stored server-side, not in the browser

### 3. Server auth persistence
The Node server must store auth state in a way that survives app restarts if practical for the local environment.

Preferred storage order:

1. OS keychain / secure store
2. Encrypted local file fallback if the platform store is unavailable

Minimum acceptable behavior:
- Credentials are stored outside the browser.
- The server can reload them on restart if the storage mechanism supports it.
- Manual clearing removes both the active in-memory auth state and the persisted secret.
- The implementation should prefer a real OS credential store on desktop platforms rather than browser storage or plaintext files.

### 4. Request routing
All app-owned e3d.ai requests must pass through one shared server-side client that:
- adds API key headers or session cookies as required
- retries or refreshes auth where appropriate
- returns a clear auth error when re-authentication is required

This shared client should be used anywhere the app currently fetches e3d.ai data directly.

### 5. Error handling
If auth fails, the app must:
- show a useful error message in the UI
- avoid leaking raw secrets into logs
- avoid silently falling back to anonymous mode when the requested endpoint requires auth
- preserve any existing cached or local data when possible

### 6. Security
- Never send credentials to the browser after submission.
- Never write raw passwords into dashboard state, logs, or telemetry.
- Prefer secure local storage for credentials.
- If a secure local secret store is unavailable in the current implementation, use the safest practical local fallback and document the limitation in the code comments or README.

## Suggested API Surface
Implement a small local auth API on the Node server. The exact route names can vary, but the behavior should cover this shape:

### `GET /api/e3d/auth/status`
Returns the current auth state.

Example response:
```json
{
  "ok": true,
  "mode": "api_key",
  "connected": true,
  "expires_at": null,
  "last_error": null
}
```

### `POST /api/e3d/auth/connect`
Accepts either API-key or login credentials.

Example API key body:
```json
{
  "mode": "api_key",
  "apiKey": "..."
}
```

Example login body:
```json
{
  "mode": "login",
  "username": "...",
  "password": "..."
}
```

Expected behavior:
- validate input shape
- authenticate with e3d.ai
- persist the credential/session securely
- return auth status

### `POST /api/e3d/auth/clear`
Clears the stored credentials/session and resets auth state.

### Optional helper routes
If needed, add one or more of the following:
- `POST /api/e3d/auth/test`
- `POST /api/e3d/auth/refresh`
- `GET /api/e3d/auth/me`

Only add them if they simplify the implementation.

## Suggested Server Responsibilities
The Node app should own:
- credential storage and retrieval
- auth session lifecycle
- e3d.ai request wrapper
- auth status reporting
- auth error normalization

The dashboard should own:
- the auth form
- displaying current auth status
- displaying connect / clear actions
- showing user-facing errors

## Data Handling Rules
- Never persist passwords in plaintext unless there is no alternative and the code explicitly documents why; prefer a session artifact or an encrypted secret.
- Never expose stored secrets through status endpoints.
- Never include secrets in `console.log`, API error payloads, or debug snapshots.
- If a session token expires, the status endpoint should mark the connection as invalid rather than pretending auth is healthy.

## UX Requirements
The auth panel should be easy to understand:

- Show the current mode and status at a glance.
- Make it obvious that the app can run in either API-key or login mode.
- Show a short helper message explaining why the auth exists: to lift the anonymous e3d.ai limits.
- If auth is missing, make the next action obvious.
- If auth is broken, provide a retry path without refreshing the whole page.

## Acceptance Criteria
The ticket is complete when all of the following are true:

- [ ] The dashboard can submit either an API key or username/password to the local server.
- [ ] The server can authenticate to e3d.ai using either method.
- [ ] The auth state survives restart if the chosen storage method supports persistence.
- [ ] The app can report current auth state without exposing secrets.
- [ ] All app-owned e3d.ai requests use the authenticated server-side client.
- [ ] The UI clearly shows whether the app is connected, which auth mode is active, and whether auth has failed.
- [ ] Clearing credentials removes both active and persisted auth state.
- [ ] Logging does not leak passwords, API keys, or session tokens.
- [ ] Existing deterministic trading behavior is unchanged except for having broader e3d.ai access.

## Implementation Tasks

### Task 1: Introduce a shared e3d auth client
Build a server-side helper that:
- stores auth mode and secret/session data
- validates the selected auth mode
- attaches auth to outgoing e3d.ai requests
- handles auth errors consistently

### Task 2: Add local auth persistence
Choose the safest local persistence mechanism available in the current app environment.

Possible implementations:
- encrypted local file with restricted permissions
- OS keychain / secure secret store if available
- in-memory fallback for environments that cannot persist securely

The implementation should prefer secure persistence and fail clearly if no safe option exists.

### Task 3: Add server endpoints
Add auth endpoints under `/api/e3d/auth/...` for status, connect, and clear.

### Task 4: Add dashboard UI
Add an auth settings card or modal to the dashboard with:
- mode selection
- inputs for the selected mode
- connect button
- clear button
- auth status badge
- error message area

### Task 5: Wire e3d.ai consumers to the auth client
Update all internal fetches to use the shared authenticated client.

### Task 6: Add tests / verification checks
Add whatever validation is practical in this repo:
- request shape validation
- auth persistence tests if available
- status reporting checks
- manual smoke test instructions in the spec comments or adjacent docs if needed

## Verification Checklist for the Implementer
The implementer should verify:

- entering an API key enables authenticated e3d.ai access
- entering username/password enables authenticated e3d.ai access
- UI status updates after connect / clear / failure
- no raw secrets appear in logs
- the agents can retrieve more than the anonymous story/thesis limit
- dashboard pages still load normally after the auth changes
- pipeline behavior is otherwise unchanged

## Rollout Notes
- Implement this as a local feature first.
- Keep the default path safe: if no credentials are configured, the app should still start, but e3d.ai auth-dependent surfaces should clearly show they are limited.
- Avoid bundling unrelated pipeline or trading logic changes into the same patch.
- If a secure local secret store is unavailable, document the fallback and keep the code narrowly scoped so it can be swapped later.

## Open Questions
These should be resolved during implementation if they are not already obvious from the codebase:

- What is the exact e3d.ai login/session exchange shape for username/password?
- What headers or cookies does the API key mode require?
- Is there a supported refresh endpoint or session-expiration signal?
- Which e3d.ai endpoints must be authenticated versus which are public?
- Which OS keychain adapter should we use, and what encrypted-file fallback format should we use if the platform store is unavailable?

## Definition of Done
This feature is done when the trading floor can authenticate to e3d.ai using either a login session or an API key, the UI exposes and manages that auth state cleanly, and all app-owned e3d.ai calls run through that auth layer without exposing secrets to the browser.
