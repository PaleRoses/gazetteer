# Demo runbook: act 1 and act 2

**Act 1:** a ship is delayed, and the cities and ships notice, post, cite each other and reassess. **Act 2:** the agents save a refrigerated container without rerouting the ship.

# Act 1: the world reacts

Every time below is on the **scenario clock**. That clock starts at **t0**, the moment the demo workspace's ships are first created, which is the first load of the demo workspace on an empty `DATA_DIR`. Ship state is durable, so a restart does not reset the clock. A server that has been running for hours shows the finished story: six ships at anchor and three diversions off-route. Each beat reaches the board within a minute or two of its scenario time: one ship alarm (60 s), one city alarm, then Relay.

**To catch two beats live at 16:00 PDT,** start the server on a fresh `DATA_DIR` and open `/demo` at **15:05 PDT** (22:05Z). That makes t0 15:05, so +0.90 h lands at about 15:59–16:01.

## 1.1 Open `/demo`

`/demo` signs you into the shared demo workspace. This only works on a loopback origin, and not when `GAZETTEER_DEMO=off`. The address bar then returns to `/`. The top bar has **World**, **Relay** and **Simulation**.

- **Banner.** It reads *Mixed-source workspace* (or *Simulated sources* when `GAZETTEER_LIVE_SOURCES=off`) and *ALL TIMES UTC*. While the actors start, the World panel shows *Agents joining · ready/total*.
- **What's in the workspace.** 33 voyages across 14 real cities. Ten of the cities have watches (actors): every city some ship still calls at. Busan, Ningbo-Zhoushan, Port Klang and Jebel Ali are origins only, so they show as normal with no watch.
- **The lanes** you will see on the map:
  - Asia to Europe via Suez
  - the transpacific
  - Asia to the US East Coast via Panama
  - intra-Asia and the Gulf
  - the North Atlantic
  - Santos

**On the board at t0:**

- **Singapore traffic watch:** *severe, 1 ship anchored outside, 6 arrivals due within 48 h.* The anchored ship is the veteran, **gz-1074 Zhoushan Patience**, 16 km out and 15 h at anchor. That figure comes from its 24 h of history, so it shows on the first alarm. It posts *delayed* by rule, and its ETA stays at 2026-10-30 21:00Z because it is the head of the queue.
- **Rotterdam traffic watch:** *elevated, 0 ships anchored outside, 3 arrivals due within 48 h.* The three are gz-1048 Baltic Dawn, gz-1049 North Sea Voyager and gz-1050 Nordic Pioneer.
- **gz-1051 Meridian Crest** (Indian Ocean): slow steaming at 6.8 kn against the 17 kn its ETA needs. Delayed by rule.
- **gz-1052 Pacific Dawn** (mid-Pacific): an open AIS gap of 14 h. Watch by rule.

## 1.2 The Singapore queue (+0.2 h to +2.0 h)

Five arrivals reach their baseline ETA and go to anchor 10 to 25 km out, at 0.1 kn with nav status *at anchor*. Each time one does, the traffic watch posts the new count:

| t0 + | Ship that anchors (km out) | Singapore watch posts |
|---|---|---|
| 0.00 h | gz-1074 Zhoushan Patience (16), already at anchor | severe, 1 anchored |
| 0.20 h | gz-1046 Orient Harbour (12) | severe, 2 anchored |
| 0.50 h | gz-1047 Cape Meridian (18) | severe, 3 anchored |
| 0.90 h | gz-1065 Malacca Courier (15) | severe, 4 anchored |
| 1.40 h | gz-1067 Dune Navigator (21) | severe, 5 anchored |
| 2.00 h | gz-1073 Haeundae Breeze (24) | severe, 6 anchored |

**Inbound ships react one alarm after each post.** Every ship still due at Singapore that has not yet anchored moves its ETA by the queue ahead of it divided by Singapore's service rate. That rate is 1.11 departures an hour, an assumption. For this queue that rounds to one hour per anchored ship. The ship then posts a rule-based watch, for example: *"by rule: watch. a queue ahead delays a call. 3 anchored at Singapore, 3 h likely queue delay."*

- **gz-1042 Meridian Star** (Shanghai to Rotterdam via Singapore) moves +1, +2, +3, +4, then +5 h by +1.42 h. That takes its Singapore call from 2026-11-01 12:00Z to 17:00Z, and Rotterdam moves by the same 5 h.
- **gz-1073 Haeundae Breeze** goes from 14:00Z to 19:00Z, +5 h by +1.42 h, before anchoring itself at +2.0 h.
- **The others** move until they anchor:
  - gz-1046: +1 h
  - gz-1047: +2 h
  - gz-1065: +3 h
  - gz-1067: +4 h

## 1.3 The Red Sea diversion

Three ships planned via Suez are sailing the Cape of Good Hope lane at their service speed. On the plan they appear normal at first. When one passes 50 km from its planned route, it posts *off-route* (*"Vessel off the planned route. 50.x km off the planned route."*) and a watch by rule:

| t0 + | Ship |
|---|---|
| 0.90 h | gz-1055 Strait Venturer (Port Klang to Antwerp), north of Sumatra |
| 1.07 h | gz-1057 Serendib Trader (Colombo to Rotterdam), west of Sri Lanka |
| 1.47 h | gz-1058 Gulf Meridian (Jebel Ali to Rotterdam), off Oman |

## 1.4 A disruption from the Simulation page

Go to **Simulation**, then **Test a city disruption**. **City** defaults to Singapore and **Congestion delay** to 36 h (allowed range 1–168). Press **Simulate port delay**.

- **Who it reaches.** The city's hazard watch holds it and publishes it. Every ship that still calls at Singapore applies it. That is nine ships:
  - gz-1042 Meridian Star
  - gz-1044 Atlas Venture
  - gz-1046 Orient Harbour
  - gz-1047 Cape Meridian
  - gz-1051 Meridian Crest
  - gz-1065 Malacca Courier
  - gz-1067 Dune Navigator
  - gz-1073 Haeundae Breeze
  - gz-1074 Zhoushan Patience
- **Without a model,** each ship moves exactly +36 h and turns *delayed*. Its change text reads *"Deterministic fallback (reason): Singapore disruption adds 36h to the arrival estimate."*
- **With a model,** the AI gives a range and a confidence instead.
- **The evidence item** reads *Simulated port congestion: "Synthetic terminal bulletin: a 36-hour berth delay at Singapore. Deterministic demo assessment; not live intelligence."*
- **Ships that don't call at Singapore are untouched,** gz-1043 and gz-1045 for example.

## 1.5 Ask a ship

The client has **no Ask button** at this commit. The endpoint is `POST /api/workspaces/:workspaceId/shipments/:shipmentId/ask` with `{ "question": "..." }`. To use it, open the browser console on the app page:

```js
const ws = (await (await fetch('/api/session')).json()).workspaces[0].id;
await (await fetch(`/api/workspaces/${ws}/shipments/gz-1074/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Why are you delayed?' }) })).json();
```

- **With `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID` set,** the answer is `{ answer, cited, mind, session }`.
- **If the key is set but the workspace id is missing,** you get a 503: `{"error":"The ship mind is unavailable until ANTHROPIC_WORKSPACE_ID is set."}`. Nothing is spawned. The ships' own assessments then fall back to rule-based or deterministic ones that state their reason.
- **Without a key,** you get *"The ship mind is unavailable: no ANTHROPIC_API_KEY is configured."*
- **An unknown ship** gives a 404, `Ship not found`.

# Act 2: saving the reefer aboard Meridian Star

**All of act 2 is sandbox data** from `src/core/services.ts`. The terminal desk, the haulier and the consignee are fictional; the port (Rotterdam) and the road (Rotterdam to Venlo) are real. No operator quoted these prices or times.

**How act 2 tells time.** Every act 2 time counts hours from one anchor: Meridian Star's (gz-1042) original Rotterdam arrival on the scenario clock, rounded down to the hour (`act2Anchor`). On the board that instant is t0 + 312 h, so its clock times depend on t0. Read *anchor + 8 h* wherever the storyboard says 18:00; the storyboard is the anchor read as 10:00. The board prints UTC (`HH:MMZ`).

## 2.1 The cargo and what it is owed

- **The box.** Reefer **MSTU 418265 1** (a valid ISO 6346 check digit) aboard Meridian Star, holding chilled produce at +2 °C.
- **Its commitments.** It must reach **Venlo DC by anchor + 13.5 h (23:30)**. A truck was booked at **anchor + 4 h (14:00)**. The budget is **EUR 1,800**, and the box needs power the whole time.
- **What breaks.** The presenter opens the act with *Delay Meridian Star* (2.5), a declared **6 h delay**: arrival moves from anchor (10:00) to **anchor + 6 h (16:00)**. The 14:00 truck can no longer be met, so the cargo agent opens a recovery case.

## 2.2 The negotiation, step by step

The numbers come from the data; the order comes from the deterministic negotiator (`agents/cargo/negotiate.ts`) and the real solver `fit()`. `test/core/services.test.ts` drives this exact sequence through `fit()` and `remedyFor()`. Without a model, every plan is labelled `rule-based`.

1. **Ask.** The cargo agent asks Rotterdam's terminal desk for an unloading window after 16:00 and for powered storage from unloading until pickup. It asks Rotterdam's haulier for a reefer truck to Venlo.
2. **First offers.**
   - Terminal: unload at **18:00 for EUR 140**.
   - Terminal: plug **R-114** from 18:00 at **EUR 95 an hour**, offered for its one-hour minimum.
   - Haulier: the earliest truck, **17:00 for EUR 640**.
3. **The blocker.** The plan is blocked: *"The truck leaves at 17:00Z, before the container is unloaded at 18:00Z."* (`truck-before-unload`, times shifted by the anchor). The cargo agent asks the haulier for a truck after 18:00.
4. **A later truck.** The haulier offers **19:30 for EUR 720**, arriving in Venlo at **21:45**.
5. **Power to match.** The plug's one-hour block ends before 19:30 (`storage-gap`), so the cargo agent asks the terminal for power until 19:30. R-114 is offered from **18:00 to 19:30 for EUR 142.50**. This step is one round more than the storyboard shows.
6. **It fits.** Delivery at **21:45**, which beats 23:30. The cost is **EUR 1,002.50** (140 + 142.50 + 720), within EUR 1,800. The cargo agent posts a hold on each of the three offers, confirms them and releases what it no longer needs. Each provider records the holds, confirms and releases on its own offers in the sandbox ledger. Every booking is keyed by case and offer, so nothing can be booked twice.

## 2.3 A change: the 19:30 truck is withdrawn

The haulier posts a withdrawal. The cargo agent keeps the 18:00 unload, which still works, and asks again:

- **Haulier:** next truck after 18:00, **21:00 for EUR 760**, arriving in Venlo at **23:15**.
- **Terminal:** R-114 extended to **18:00–21:00 for EUR 285**. This is a new offer id, so the 18:00–19:30 power can be released.
- **New plan:** delivery at **23:15**, still before 23:30, for **EUR 1,185** (140 + 285 + 760). The ship is not rerouted.

## 2.4 An interruption: restart the cargo agent

*Restart cargo agent* (`POST /api/workspaces/:id/restart-cargo`) calls the cargo agent's `resume()`; it does not kill a process. The cargo agent restarts from its saved case and replays the board and the ledger; nothing books twice. `test/server/runtime/recovery.restart.test.ts` proves this against real actors: restarted before it answers the offers it was just sent, it leaves one ledger row per key and the case still recovers. The ledger (`GET /api/workspaces/:id/bookings`) shows one row per case and offer. R-114 has two rows after the withdrawal, 18:00–19:30 released and 18:00–21:00 confirmed, because the extension is a new offer.

## 2.5 What act 2 needs that this runbook cannot vouch for

What has landed, as of this commit:
- **The protocol and solver:** `core/recovery.ts`, plus the board kinds and their rendering in the client.
- **The ledger and its endpoint:** the sandbox ledger and `GET /api/workspaces/:id/bookings`.
- **The three agents:** the deterministic negotiator and the durable CargoAgent, the HaulierAgent, and the TerminalDesk (93a9d7b), which answers with `terminalQuote`.
- **This data:** `core/services.ts`.
- **The act 2 runtime** (a7155e3, opened on a control since 426fa73). The cargo agent, Rotterdam's terminal desk and its haulier start beside act 1's actors, and each recovery message is routed to the actor it is for. The anchor is read from Meridian Star's own actor.
- **The ledger law** (94d6142). Each provider writes the rows for its own offers; the cargo agent only posts its holds, confirms and releases and reads the ledger back.
- **The epoch fix** (d7827c2). The scenario clock's t0 is written once beside relay-seq, so a server restart keeps the anchor and the ETAs the persisted actors already hold.
- **The three act 2 controls**, buttons in the recovery panel at the top of the Simulation tab (9f9417a, fadd03a). Each press calls a POST route, the second way in for a member of the workspace; it answers with the dashboard.
  - *Delay Meridian Star* (`POST /api/workspaces/:id/delay-meridian-star`) opens act 2. It starts the three actors, and the cargo agent opens its case on the declared 6 h delay. Until it is pressed, the panel reads "Act 2 has not started" and `Dashboard.recovery` is absent. Once the case is open the button is disabled; a second POST returns the open case. It declares the delay to the cargo; it does not move Meridian Star's ETA on the map.
  - *Withdraw truck* (`POST /api/workspaces/:id/withdraw-truck`): the haulier withdraws its last-departing open truck, and with it whatever the ledger holds for that truck. Press it after the 19:30 plan is confirmed. The button is disabled after one withdrawal; a second POST would withdraw the 21:00 truck too.
  - *Restart cargo agent* (`POST /api/workspaces/:id/restart-cargo`): see 2.4.
- **The press runs the act by itself** (2119094). After each press, a delivery or an actor becoming ready, the server steps the three actors until two rounds say nothing new. One press of *Delay Meridian Star* reaches three confirmed reservations and a delivery date, with nobody stepping the actors. The seat ran act 2 end to end on 2119094: the 19:30 truck at EUR 1,002.50, then after *Withdraw truck* the 21:00 truck at EUR 1,185.
- **The recovery panel** (9f9417a). It lights the six steps from the case's own recovery posts, and shows the negotiation with who answers whom, the blocking constraint, and the reservations with their status and hold countdowns. They come from `Dashboard.recovery`, the case labelled `rule-based`, and every reservation of the workspace, read from the ledger. `GET /api/workspaces/:id/bookings` returns the same rows.
- **Whose case a reservation is for** (56f3fb7). A row's `heldBy` names the cargo agent whose case holds it, on the haulier's rows and the terminal desk's alike.

What this runbook cannot yet vouch for:
- **The pace.** After *Delay Meridian Star*, the negotiation runs at the actors' pace, not on the scenario clock. It has not been timed against the pinned server.

Check each against the build before showing it. If act 2 is not green on the pinned server, the demo runs act 1 and shows act 2 only as far as it is real; nothing is staged by hand.

# What is live and what is simulated

**Simulated:**

- Every fleet ship's position, speed, navigation status and 24 h of history. Everything derived from them is simulated too: each `ship.observation` and each traffic watch's anchored and arrival counts. Their provider and provenance are `simulation`, never `live`.
- The queue, the diversion, the slow ship and the dark ship are scripted on the scenario clock.
- Vessel names are fictional, and no carrier is named.
- Disruptions from the Simulation page are synthetic and are labelled as such.
- Act 2's terminal desk, haulier, consignee, prices and times are sandbox data, and its bookings are sandbox records.

**Real:** the 14 cities (names, UN/LOCODEs, coordinates) and the sea lanes. The lanes are searoute-ts paths over the Eurostat maritime network, illustrative and not for navigation.

**Assumed:** service rates. Each is derived from the port's 2023 container throughput over an assumed 4,000 TEU exchanged per call.

**Live:**

- The hazard watch reads GDACS, USGS and NWS notices unless `GAZETTEER_LIVE_SOURCES=off`. Each notice carries its provider, URL and fetch time, which is why the banner says *mixed*.
- The Digitraffic AIS feed at `/api/ingest` is live Baltic traffic. It is separate from the demo fleet.

**AI:** an assessment is AI only when the model is configured and says so. An AI assessment is not live evidence.
