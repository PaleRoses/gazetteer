# Gazetteer

Gazetteer is a shared operations workspace for teams monitoring commercial ocean shipments. It answers four questions: **Where is the cargo? When will it arrive? What changed? What needs our attention?**

The main screen is a map, not an agent dashboard. Select a vessel to see its route, cargo, milestones, current ETA, changes to that ETA, risks, supporting evidence and the next action. Teammates work from the same shipments, updates and comments.

## Essential product behavior

1. **Durable monitoring:** every port and shipment has its own Terse Durable Actor. Monitoring state must survive process restarts; scheduled checks must continue without an open browser.
2. **Port-to-shipment communication:** port agents publish developments through Agent Relay. Shipment agents consume relevant notices, assess their route/cargo exposure, revise ETAs and flag risks with evidence. Replayed notices must not add the same delay twice; unaffected shipments must remain unchanged.
3. **A useful operations map:** selectable vessels and clear risk icons lead to route/milestones, current ETA, what changed and any action needed. Use familiar logistics terminology and compact copy—not agent-count vanity metrics.
4. **A genuinely shared workspace:** accounts, email-addressed invitations and owner/member roles. Members see the same shipment state and comments; other workspaces cannot access them. Only owners invite teammates.
5. **One complete demo journey:** create a workspace, invite/join as a teammate, simulate a Singapore disruption, observe affected vessels and ETAs change, inspect evidence, leave a shared comment, restart, and retain the resulting state.
6. **Honest provenance:** synthetic notices are always labelled simulated. An unconfigured provider, unsent invitation or unverified integration must never be presented as live or successful.

These are acceptance requirements, not a claim that every integration has been verified. Finish this complete flow before adding more features. The supplied visual starting point is `reference/gazetteer.html`.

## Current implementation and limits

**All shipment positions, cargo, port notices and ETA assessments are synthetic.** Terse and Agent Relay are real integrations; the demo's impact assessment is currently deterministic, not LLM inference. No live AIS/carrier feed is connected. The intended AI-backed monitoring must retain evidence and report uncertainty rather than invent logistics facts.

Accounts, owner/member workspaces, invitation links and shared comments are implemented. Actual email delivery needs configured credentials and a verified sender; remote teammate access needs a reachable deployment. See `HANDOFF.md` for the checks actually performed and remaining gaps—neither a passing build nor a provider adapter establishes end-to-end operation.

## Run

Requires Node/npm for bootstrapping; the project pins its own Bun 1.4.4 runtime because Terse requires Bun 1.4.2 or later. `bun.lock` is the dependency source of truth. Use the npm scripts after installation so Terse's child processes resolve the pinned Bun rather than an older global binary.

```sh
npx --yes bun@1.4.4 install --frozen-lockfile
test -f .env || cp .env.example .env
npm run setup:relay
npm run build
npm start
```

Open **http://localhost:4310**. Create an account (password: 12+ characters); your workspace receives four synthetic shipments. Select **Simulate disruption** to publish a 36-hour Singapore delay. Two exposed shipments change ETA and risk; the two other voyages stay unchanged. Repeated delivery of the same evidence does not add the delay twice.

`setup:relay` creates a real private Agent Relay/Relaycast demo workspace. Only synthetic disruption records and generated actor identities are sent there. It stores its credential in ignored `.env`; a fresh checkout must configure its own workspace. Terse downloads its local runtime on first start. Network access is required for setup and Relay; there is no counterfeit offline fallback.

## Shared access

The workspace owner can invite an email address. The invitee registers/signs in with that exact address and accepts the single-use link. Members share shipments, updates and comments; only owners can invite. The UI refreshes shared state every five seconds.

Without `RESEND_API_KEY` and a verified `MAIL_FROM`, an invitation produces a **manual share link**, not a sent email. Configure both for actual email delivery; a partial configuration is rejected. The UI distinguishes a provider-accepted email from an unconfirmed send—neither is proof of inbox delivery. Set `APP_ORIGIN` to the reachable HTTPS origin before sharing remotely, and run behind a TLS proxy with a persistent data volume. A localhost link is not reachable by a teammate on another machine.

There is no password reset, account email verification, membership removal, production operations setup, or live-source ingestion yet. This is a handoff-ready basic demo, not a production authentication platform.

## Ownership

- `src/core/demo.ts`: pure, idempotent synthetic shipment impact and demo catalog.
- `src/core/types.ts`: shared domain values.
- `src/server/agents/`: one persisted Terse actor per port/shipment, workspace-scoped; one-minute alarms.
- `src/server/relay/`: actual Agent Relay SDK, channel publication and replay.
- `src/server/runtime/monitoring.ts`: Terse local lifecycle and typed actor calls; no second actor implementation.
- `src/server/access/access.ts`: SQLite accounts, hashed session/invitation tokens, owner/member checks and shared comments.
- `src/server/http/api.ts`: validated HTTP requests, membership checks, origin protection, invitation delivery.
- `src/client`: map, shipment details and shared-workspace UI.

The port actor retains a disruption outbox; shipment actors replay Relay events through the pure assessment. Durable state lives under `DATA_DIR` (default `.data`). Keep that directory and `.env` across restarts; do not commit either. Startup fails explicitly if Relay is not configured.

Terse's local control plane keeps its alarm index in memory. Gazetteer therefore persists each actor's next-check deadline and restores native alarms at startup from the canonical workspace inventory. Dashboard polling does not reschedule or postpone those checks; there is no second application scheduler.

## Development and checks

```sh
npm run check
npm test
npm run build
```

The real-provider restart/alarm/replay check is opt-in:

```sh
npm run test:runtime
```

It uses the configured Relay workspace, isolated `.data/runtime-check` actor data and a synthetic test channel. It publishes a one-hour test disruption, restarts Terse, and checks scheduled delivery and duplicate replay. Allow several minutes; do not run it concurrently with another process using that test data directory. The regular test suite skips this external-provider check explicitly.

For UI hot reload, run `APP_ORIGIN=http://localhost:5173 npm run dev` and `npm run dev:ui` in separate terminals, then visit `http://localhost:5173`. API requests proxy to port 4310.

Focused tests cover deterministic impact, duplicate delivery, persistent account/access state, tenant isolation, invite acceptance, comments, CSRF and auth throttling. Runtime integration evidence and remaining handoff work are recorded in `HANDOFF.md`.

## Upstream contracts

[Terse Durable Actors](https://github.com/TerseAI/durable-actors), [Agent Relay SDK](https://agentrelay.com/docs/typescript-sdk), and [Resend email API](https://resend.com/docs/api-reference/emails/send-email).
