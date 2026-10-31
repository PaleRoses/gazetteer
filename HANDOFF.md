# Claude Code handoff

## Scope

2026-10-31: Rosalia requested the **basics**, built in pale-meridian and handed off through a shared private GitHub repository. Do not turn this into an expansive platform build. Priorities: a complete synthetic port disruption → Relay → durable shipment state → map/risk/ETA flow, then straightforward shared access.

Private repository: https://github.com/PaleRoses/gazetteer

Daniel's GitHub account `dfialkov` was invited with **write** permission on 2026-10-31 (invitation 340776364). Invitation is pending acceptance. No Gazetteer workspace invitation has been sent, and no account was created on behalf of Rosalia or Daniel.

Canonical checkout: `/Users/bluerose/Developer/gazetteer`, moved from the initial pale-meridian location at Rosalia's request. The original app copy was removed; there is only one implementation owner. This standalone repository contains only Gazetteer, not pale-meridian's unrelated source/history.

## Implemented

- React/Vite map-first UI with selectable vessels, routes, milestones, cargo, current ETA/delta, risk, evidence and next action.
- Supplied visual reference retained at `reference/gazetteer.html`; navy/blue palette, compact logistics language and coastline incorporated without importing its mock agent-count/activity surfaces.
- Actual Terse Durable Actors, workspace-scoped port/shipment identities, persisted records and one-minute alarms.
- Actual Agent Relay SDK and private demo Relay workspace setup. Synthetic notices carry idempotency keys; pure shipment assessment only changes exposed routes.
- Bun/SQLite accounts, Argon2id passwords, hashed opaque sessions, owner/member roles, email-bound single-use invitation links and shared comments.
- Optional Resend delivery; without credentials the UI explicitly says the invitation is a manual share link, not sent email.

## Validation so far

`npm run check`, `npm test` and `npm run build` passed: **10 tests, 82 assertions**. Tests cover pure impact/idempotency, restart persistence for account/comment state, authorization, invite acceptance, CSRF, and auth throttling. The HTTP tests use a named test monitoring fixture; they do **not** prove Terse/Relay integration.

**Actual runtime flow passed (worker-run integration, exit 0):** real Terse and real Agent Relay started with four on-track shipments. A Singapore +36h disruption changed only `gz-1042` and `gz-1044` to delayed, advanced both ETAs by exactly 36 hours and attached one evidence record. `gz-1043` and `gz-1045` retained their ETAs, on-track status and no disruption evidence. Runtime shut down cleanly. Actor restart persistence was not independently tested; the focused restart test covers accounts/comments only.

Cold initialization took roughly 90 seconds. Live Relay provisioning exposed upstream overload/rate limits. Registration was serialized, retries bounded, and partial initialization retained. Browser polling now waits for settlement instead of piling up requests; HTTP allows a 120-second cold-start window. Provider availability remains a real prerequisite, not hidden by a local fake.

Browser account creation succeeded. Final map interaction/visual QA was not completed: after relocating the checkout, the in-app browser remained on its connection-error page. The relocated server returned HTTP 200 and was stopped after the check; use `npm start` to run it again. Do not describe the UI as browser-verified end-to-end.

## Boundaries and next work

- All logistics data and impact calculations are synthetic and deterministic, not live feeds or LLM reasoning. External source ingestion, evidence grounding and AI assessment remain unimplemented.
- This is a local Bun/Terse runtime, not a deployed shared service. For remote teammates, deploy with persistent storage and a reachable HTTPS `APP_ORIGIN`. Never send localhost invitation links as usable remote access.
- Each fresh checkout must run `setup:relay`; `.env`, credentials and `.data` are deliberately excluded from GitHub. Preserve those locally across restarts.
- No actual email delivery was exercised. Configure a verified sender and Resend key before claiming email invitations work end-to-end.
- Account email verification/reset, member removal, production resource limits and operational deployment remain out of scope for this basic slice.
- Relay replays channel history for this small demo; cursor-based processing and bounded retention belong to a later scale requirement, not this handoff.

Start with the README run commands. Keep subsequent work bounded; remote deployment and live AI/source ingestion are the next substantive gaps, not cosmetic dashboard expansion.
