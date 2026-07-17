---
name: E2e testing subagent quirks
description: Constraints of the runTest Playwright subagent in this project (env access, workflow restarts, auth strategy for admin-web)
---

# E2e testing subagent quirks

- The testing subagent has **no access to process.env** (secrets like ADMIN_TOKEN cannot be read inside a test). Never write a test plan step that reads env vars.
- The subagent (or the platform around a test run) can **restart workflows at the start of a run**, wiping any in-memory server state. **Why:** admin sessions lived in an in-memory Map; every pre-created session cookie died before the test's first page load, causing redirect-to-login failures that looked like app bugs.
- **How to apply:** for admin-web e2e, rely on the dev-only session persistence in `adminAuth.ts` (sessions mirrored to `/tmp/aegis_admin_sessions.json` when NODE_ENV≠production): log in via curl with $ADMIN_TOKEN, extract the `aegis_admin_session` cookie value, and pass it to the test plan via Playwright `context.addCookies` (domain `localhost`, path `/`). Never paste ADMIN_TOKEN itself into a test plan.
- The code_execution notebook times out at ~600s and loses state; keep runTest plans short and re-register test users per attempt. Clean up `e2e_*@test.local` users from `app_users` afterwards.
