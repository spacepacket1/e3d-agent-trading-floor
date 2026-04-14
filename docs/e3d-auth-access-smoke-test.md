---
description: Manual smoke test checklist for the e3d.ai auth flow in the trading floor app
---
# e3d.ai Auth Smoke Test

Use this checklist to verify the new e3d.ai auth flow works end to end after implementation.

## Prerequisites
- Start the trading floor server.
- Open the dashboard in the browser.
- Have a valid e3d.ai account login or API key available.
- Confirm the local machine can access the OS keychain if you want to test the preferred persistence path.

## 1. Check auth status before connecting
- Open the dashboard.
- Verify the new **e3d.ai access** card shows `Not connected`.
- Click **Refresh status**.
- Confirm the status remains unauthenticated and no secrets are displayed.

## 2. Test API key mode
- Select **API key** from the auth mode selector.
- Paste a valid e3d.ai API key.
- Click **Connect**.
- Verify the UI shows a connected state.
- Refresh the page.
- Verify the auth state persists after reload.
- Open the network tab or server logs and confirm the API key is not echoed back in plaintext.

## 3. Test username/password mode
- Select **Username/password** from the auth mode selector.
- Enter the e3d.ai email/username and password.
- Click **Connect**.
- Verify the UI shows a connected login session state.
- Refresh the page.
- Verify the login session persists after reload if the server stored it successfully.
- Confirm the password is not shown in the UI or logs.

## 4. Verify auth status endpoint
- Request `GET /api/e3d/auth/status` from the browser or curl.
- Confirm the response reports the current connection mode.
- Confirm the response does not include the raw API key or password.
- If connected, confirm the response includes a redacted status only.

## 5. Verify clear credentials
- Click **Clear credentials**.
- Confirm the UI changes back to `Not connected`.
- Refresh the page.
- Confirm the auth state stays cleared.
- Re-run `GET /api/e3d/auth/status` and confirm it reports no active auth.

## 6. Verify broader e3d.ai access
- Run the pipeline after authenticating.
- Confirm the agents can retrieve more than the anonymous story/thesis limit.
- Confirm no auth-related failures appear in the dashboard.
- Confirm the trading floor still renders portfolio, history, and activity normally.

## 7. Verify fallback behavior
- If the OS keychain is unavailable, confirm the app falls back to the encrypted local file path.
- Confirm the UI still reports a valid connected state.
- Confirm clearing credentials removes both the active state and the persisted fallback record.

## Expected results
- The dashboard exposes a clear auth state at all times.
- e3d.ai login/session and API key modes both work.
- No raw credentials appear in logs, UI state, or status responses.
- The trading floor continues to operate deterministically once authenticated.
