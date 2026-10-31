# Demo runbook (three minutes)

Every time below is on the **scenario clock**. That clock starts at **t0**, the moment the demo workspace's ships are first created, which is the first load of the demo workspace on an empty `DATA_DIR`. Ship state is durable, so a restart does not reset the clock. A server that has been running for hours shows the finished story: six ships at anchor and three diversions off-route. Each beat reaches the board within a minute or two of its scenario time: one ship alarm (60 s), one city alarm, then Relay.

**To catch two beats live at 16:00 PDT,** start the server on a fresh `DATA_DIR` and open `/demo` at **15:05 PDT** (22:05Z). That makes t0 15:05, so +0.90 h lands at about 15:59–16:01.

## 1. Open `/demo`

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

## 2. The Singapore queue (+0.2 h to +2.0 h)

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

## 3. The Red Sea diversion

Three ships planned via Suez are sailing the Cape of Good Hope lane at their service speed. On the plan they appear normal at first. When one passes 50 km from its planned route, it posts *off-route* (*"Vessel off the planned route. 50.x km off the planned route."*) and a watch by rule:

| t0 + | Ship |
|---|---|
| 0.90 h | gz-1055 Strait Venturer (Port Klang to Antwerp), north of Sumatra |
| 1.07 h | gz-1057 Serendib Trader (Colombo to Rotterdam), west of Sri Lanka |
| 1.47 h | gz-1058 Gulf Meridian (Jebel Ali to Rotterdam), off Oman |

## 4. A disruption from the Simulation page

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

## 5. Ask a ship

The client has **no Ask button** at this commit. The endpoint is `POST /api/workspaces/:workspaceId/shipments/:shipmentId/ask` with `{ "question": "..." }`. To use it, open the browser console on the app page:

```js
const ws = (await (await fetch('/api/session')).json()).workspaces[0].id;
await (await fetch(`/api/workspaces/${ws}/shipments/gz-1074/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'Why are you delayed?' }) })).json();
```

- **With `ANTHROPIC_API_KEY` and `ANTHROPIC_WORKSPACE_ID` set,** the answer is `{ answer, cited, mind, session }`.
- **If the key is set but the workspace id is missing,** you get a 503: `{"error":"The ship mind is unavailable until ANTHROPIC_WORKSPACE_ID is set."}`. Nothing is spawned. The ships' own assessments then fall back to rule-based or deterministic ones that state their reason.
- **Without a key,** you get *"The ship mind is unavailable: no ANTHROPIC_API_KEY is configured."*
- **An unknown ship** gives a 404, `Ship not found`.

## What is live and what is simulated

**Simulated:**

- Every fleet ship's position, speed, navigation status and 24 h of history. Everything derived from them is simulated too: each `ship.observation` and each traffic watch's anchored and arrival counts. Their provider and provenance are `simulation`, never `live`.
- The queue, the diversion, the slow ship and the dark ship are scripted on the scenario clock.
- Vessel names are fictional, and no carrier is named.
- Disruptions from the Simulation page are synthetic and are labelled as such.

**Real:** the 14 cities (names, UN/LOCODEs, coordinates) and the sea lanes. The lanes are searoute-ts paths over the Eurostat maritime network, illustrative and not for navigation.

**Assumed:** service rates. Each is derived from the port's 2023 container throughput over an assumed 4,000 TEU exchanged per call.

**Live:**

- The hazard watch reads GDACS, USGS and NWS notices unless `GAZETTEER_LIVE_SOURCES=off`. Each notice carries its provider, URL and fetch time, which is why the banner says *mixed*.
- The Digitraffic AIS feed at `/api/ingest` is live Baltic traffic. It is separate from the demo fleet.

**AI:** an assessment is AI only when the model is configured and says so. An AI assessment is not live evidence.
