# Claude Code handoff

## Scope

2026-10-31: Rosalia requested the **basics**, built in pale-meridian and handed off through a shared private GitHub repository. Do not turn this into an expansive platform build. Priorities: a complete synthetic port disruption → Relay → durable shipment state → map/risk/ETA flow, then straightforward shared access.

Private repository: https://github.com/PaleRoses/gazetteer

Daniel's GitHub account `dfialkov` was invited with **write** permission on 2026-10-31 (invitation 340776364). Acceptance has not been rechecked. No Gazetteer workspace invitation has been sent to Daniel, and no account was created on behalf of Rosalia or Daniel.

Canonical checkout: `/Users/bluerose/Developer/gazetteer`, moved from the initial pale-meridian location at Rosalia's request. The original app copy was removed; there is only one implementation owner. This standalone repository contains only Gazetteer, not pale-meridian's unrelated source/history.

## Implemented

- React/Vite map-first UI with selectable vessels, routes, milestones, cargo, current ETA/delta, risk, evidence and next action.
- Supplied visual reference retained at `reference/gazetteer.html`; navy/blue palette, compact logistics language and coastline incorporated without importing its mock agent-count/activity surfaces.
- Actual Terse Durable Actors, workspace-scoped port/shipment identities, persisted records and one-minute alarms.
- Actual Agent Relay SDK and private demo Relay workspace setup. Synthetic notices carry idempotency keys; pure shipment assessment only changes exposed routes.
- Bun/SQLite accounts, Argon2id passwords, hashed opaque sessions, owner/member roles, email-bound single-use invitation links and shared comments.
- Optional Resend delivery; without credentials the UI explicitly says the invitation is a manual share link, not sent email.

## Initial-pass evidence

`npm run check`, `npm test` and `npm run build` passed: **10 tests, 82 assertions**. Tests cover pure impact/idempotency, restart persistence for account/comment state, authorization, invite acceptance, CSRF, and auth throttling. The HTTP tests use a named test monitoring fixture; they do **not** prove Terse/Relay integration.

**Actual runtime flow passed (worker-run integration, exit 0):** real Terse and real Agent Relay started with four on-track shipments. A Singapore +36h disruption changed only `gz-1042` and `gz-1044` to delayed, advanced both ETAs by exactly 36 hours and attached one evidence record. `gz-1043` and `gz-1045` retained their ETAs, on-track status and no disruption evidence. Runtime shut down cleanly. Actor restart persistence was not independently tested; the focused restart test covers accounts/comments only.

Cold initialization took roughly 90 seconds. Live Relay provisioning exposed upstream overload/rate limits. Registration was serialized, retries bounded, and partial initialization retained. Browser polling now waits for settlement instead of piling up requests; HTTP allows a 120-second cold-start window. Provider availability remains a real prerequisite, not hidden by a local fake.

Browser account creation succeeded. Final map interaction/visual QA was not completed: after relocating the checkout, the in-app browser remained on its connection-error page. The relocated server returned HTTP 200 and was stopped after the check; use `npm start` to run it again. Do not describe the UI as browser-verified end-to-end.

## Completion pass — 2026-10-31

Rosalia requested four GPT-6.1 workers, a README defining the essential product behavior, and frequent commit/push checkpoints. `91ae424` published the README, startup validation, date-line route repair, workspace/polling isolation and honest invitation email receipts.

Current local checks: `npm run check` passes; `npm test` reports **39 pass, 1 explicitly skipped live-provider test, 205 assertions**. The latest frontend production build passed. Provider failures now remain typed through HTTP, so a queued disruption's retry status is not lost behind a generic exception.

The first real restart test preserved shipment snapshots but **failed scheduled delivery after 150 seconds**. The confirmed cause is Terse 0.14.6's local `MemoryAlarmStore`: its native scheduler index is not restored by actor SQLite snapshots. The repair persists each actor's next deadline and restores native alarms once at application startup using workspace IDs from the existing account store. It does not introduce an application polling scheduler.

The final real-provider run exercised the production startup recovery and proved exact retained snapshots, automatic queued delivery, +1h/+3,600,000ms only for the two exposed shipments, and unchanged unexposed shipments. **The full test still exited 1 at its 240-second limit during additional duplicate-replay reads; final replay assertions were not reached.** That failure remains in the test surface. Pure duplicate/idempotency tests pass, but are not a substitute for the unresolved external-provider replay check. No further provider runs were attempted.

Correction: the earlier claim that failed RPCs necessarily lose persisted state through rollback was too strong. The native runtime uses immediate SQLite writes; the established defect is the memory-only alarm index. Typed provider outcomes and separated enqueue/publication remain explicit failure semantics, not proof of an upstream data-loss bug.

Browser checking on the earlier stable build at 1280×720 loaded four shipments, selected the Pacific route/details, verified date-line rendering and a manual invitation labelled email-not-sent, and checked Team open/close after repairing a duplicate workspace panel key. The disruption UI stayed pending beyond two minutes; no browser impact success was claimed. Native traces showed its provider calls completing in roughly 37 seconds, so the cause of the remaining UI wait was not established. The later client deadline and invitation gate passed typecheck/build but were not browser-verified. Signup/join/shared-comment and mobile browser checks remain unverified.

The client bounds requests at 125 seconds and labels timeout outcomes unconfirmed. The installed Relay SDK offers retry counts but no request AbortSignal/deadline option; do not claim its network requests are wall-clock bounded.

The tree then received a concurrent map/realtime/assessment rewrite outside this workstream, including staged removals of the original route helper. Those edits and staged entries were preserved; no compilation chase or browser acceptance was performed against that moving target. Checkpoints `91ae424` and `877dffa` are pushed. This pass's remaining commit is path-scoped to startup inventory/configuration ownership and this record, excluding the other workstream. The owned preview server was stopped; start a fresh server after that integration is coherent.

## Boundaries and next work

- All logistics data and impact calculations are synthetic and deterministic, not live feeds or LLM reasoning. External source ingestion, evidence grounding and AI assessment remain unimplemented.
- This is a local Bun/Terse runtime, not a deployed shared service. For remote teammates, deploy with persistent storage and a reachable HTTPS `APP_ORIGIN`. Never send localhost invitation links as usable remote access.
- Each fresh checkout must run `setup:relay`; `.env`, credentials and `.data` are deliberately excluded from GitHub. Preserve those locally across restarts.
- No actual email delivery was exercised. Configure a verified sender and Resend key before claiming email invitations work end-to-end.
- Account email verification/reset, member removal, production resource limits and operational deployment remain out of scope for this basic slice.
- Relay replays channel history for this small demo; cursor-based processing and bounded retention belong to a later scale requirement, not this handoff.

Start with the README run commands. Keep subsequent work bounded; remote deployment and live AI/source ingestion are the next substantive gaps, not cosmetic dashboard expansion.
