# Voyage UI verification — 31 October 2026

This pass adds ship selection popups, a dedicated voyage drilldown and broader route/diversion/context intelligence. It preserves the real Terse Durable Actors and Agent Relay implementation and incorporates upstream work through `789abd9`.

## Checks

- `npm run check`: passed.
- `npm test`: 227 passed, one opt-in external-provider integration test skipped, zero failures (841 assertions).
- `npm run build`: passed. The existing MapLibre bundle-size advisory remains.
- Native Terse compilation and server startup: passed. Fixed a newly introduced extensionless shared board type import that ordinary bundler-mode TypeScript checking did not catch.
- Browser: map marker and list selection, popup → drilldown, reloadable voyage URL, browser Back, overview return, no-result search, diversion-news empty state, and diversion inspection. Desktop at 1280×720 and mobile at 390×844; no mobile page-width overflow. Map panel fills its mobile height.

## Real runtime exercise

A local QA account used a real private Relay workspace and the production Bun/Terse server, not a mock monitoring provider. After cold provisioning completed, a Singapore +36h bulletin traversed Relay. Only `gz-1042` and `gz-1044` changed: each ETA moved +36h, risk became high, and one scenario-assessment record was retained. `gz-1043` and `gz-1045` were unchanged.

Restarting the production server preserved all four shipment snapshots exactly. Native traces subsequently recorded successful `onAlarm` executions for all four shipment actors and all four port actors; repeated processing did not compound the delay. These checks were performed against the initial UI integration. After incorporating the newer upstream telemetry/cursor/SSE work, native startup, exact retained snapshots, the live SSE browser connection, and the final UI were checked again. The later board/port-status merge preserves both response fields through the client parser.

NWS, GDACS and USGS returned live notices; provider links and provenance rendered in the intelligence panel. Off-route diversion exposure is exercised by a deterministic geographic fixture, rather than inventing a current real-world diversion hazard for the screenshot.

## Limits

No Anthropic key was configured in this checkout, so no live model inference was exercised. The UI shows scenario assessment provenance and retains the existing provider pipeline for configured environments. No live AIS vessel mapping was configured. Alternatives are planning candidates with unconfirmed capacity and arrival times; inspecting them never changes retained shipment state. This pass did not deploy a remotely accessible service or send invitations/email. The standalone opt-in restart/queued-delivery integration test was not run in this pass; the runtime exercise above is distinct from that test.
