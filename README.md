# Gazetteer

Map-first shared shipment monitoring. **All shipment positions, cargo, port notices and ETA assessments are synthetic.** No AIS feed, live intelligence, or LLM inference is connected.

## Run

Requires Node/npm for installation; the project pins its own Bun 1.4.4 runtime because Terse requires Bun 1.4.2 or later.

```sh
npm install
cp .env.example .env
npm run setup:relay
npm run build
npm start
```

Open **http://localhost:4310**. Create an account (password: 12+ characters); your workspace receives four synthetic shipments. Select **Simulate disruption** to publish a 36-hour Singapore delay. Two exposed shipments change ETA and risk; the two other voyages stay unchanged. Repeated delivery of the same evidence does not add the delay twice.

`setup:relay` creates a real private Agent Relay/Relaycast demo workspace. Only synthetic disruption records and generated actor identities are sent there. It stores its credential in ignored `.env`; a fresh checkout must configure its own workspace. Terse downloads its local runtime on first start. Network access is required for setup and Relay; there is no counterfeit offline fallback.

## Shared access

The workspace owner can invite an email address. The invitee registers/signs in with that exact address and accepts the single-use link. Members share shipments, updates and comments; only owners can invite. The UI refreshes shared state every five seconds.

Without `RESEND_API_KEY` and a verified `MAIL_FROM`, an invitation produces a **manual share link**, not a sent email. Configure both for actual email delivery. Set `APP_ORIGIN` to the reachable HTTPS origin before sharing remotely, and run behind a TLS proxy with a persistent data volume. A localhost link is not reachable by a teammate on another machine.

There is no password reset, account email verification, membership removal, production operations setup, or live-source ingestion yet. This is a handoff-ready basic demo, not a production authentication platform.

## Ownership

- `src/domain.ts`: pure, idempotent synthetic shipment impact and demo catalog.
- `src/shared.ts`: shared domain values.
- `src/server/actors.ts`: one persisted Terse actor per port/shipment, workspace-scoped; one-minute alarms.
- `src/server/relay.ts`: actual Agent Relay SDK, channel publication and replay.
- `src/server/monitoring.ts`: Terse local lifecycle and typed actor calls; no second actor implementation.
- `src/server/access.ts`: SQLite accounts, hashed session/invitation tokens, owner/member checks and shared comments.
- `src/server/http.ts`: validated HTTP requests, membership checks, origin protection, invitation delivery.
- `src/client`: map, shipment details and shared-workspace UI.

The port actor retains a disruption outbox; shipment actors replay Relay events through the pure assessment. Durable state lives under `DATA_DIR` (default `.data`). Keep that directory and `.env` across restarts; do not commit either. Startup fails explicitly if Relay is not configured.

## Development and checks

```sh
npm run check
npm test
npm run build
```

For UI hot reload, run `APP_ORIGIN=http://localhost:5173 npm run dev` and `npm run dev:ui` in separate terminals, then visit `http://localhost:5173`. API requests proxy to port 4310.

Focused tests cover deterministic impact, duplicate delivery, persistent account/access state, tenant isolation, invite acceptance, comments, CSRF and auth throttling. Runtime integration evidence and remaining handoff work are recorded in `HANDOFF.md`.

## Upstream contracts

[Terse Durable Actors](https://github.com/TerseAI/durable-actors), [Agent Relay SDK](https://agentrelay.com/docs/typescript-sdk), and [Resend email API](https://resend.com/docs/api-reference/emails/send-email).
