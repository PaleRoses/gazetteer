# Route monitoring

The Routes view groups consecutive port calls into shared, two-way port-to-port corridors. A Shanghai–Singapore–Rotterdam voyage belongs to two corridors; it is not incorrectly grouped with a direct Shanghai–Rotterdam voyage. Multiple shipments and opposite directions can share a corridor. The current eleven-shipment demo produces five corridors.

Each route has a stable workspace-scoped bookmark, an approximate map path, member shipments with actual direction and final-destination ETA, endpoint bulletins, news and alternative-port candidates. Cards, map corridor lines and voyage route links open the drilldown. Browser Back, Escape and the in-app back control are supported.

Risk is explicitly the highest assessed risk among member shipments. Counts and maximum arrival delay are derived from those same shipments; they are not a new AI assessment or a corridor-wide delay forecast. An incident on a different leg can influence a member shipment's risk. Unassessed news never changes a risk or ETA.

Route news covers the full corridor and both endpoints, including an origin endpoint with no reverse-direction voyage. It is distinct from voyage news, which covers upcoming calls and the remaining path. Evidence without a known location is labelled voyage context. Notices are deduplicated, expired notices excluded, failed feed providers surfaced, and alternate ports shown without asserting capacity or changing the itinerary.

## Runtime

The read model uses retained Terse shipment state and the existing Agent Relay event pipeline. Public-feed coverage refreshes in the background; active workspaces are refreshed every minute, with the source layer's five-minute cache preventing excess public API calls. SSE publishes meaningful route/news changes; changes to coverage timestamps alone do not trigger a publication. No additional Relay identities or channels are created for route aggregation.

The frontend follows the upstream Solid migration, retains its Hono API, demo entry, agent startup/queue indicators, retry controls, and shared Relay reader. The separately developed Agent activity panel is preserved.

## Verification

- TypeScript checking and production build.
- Unit coverage: opposite-direction grouping, intermediate calls, multiple cargo bookings and repeated legs, delay/risk rollups, full-corridor endpoint exposure, unrelated/expired news, diversion relevance, API schema, SSE deduplication and workspace-scoped URLs.
- Actual local Terse/Relay run: a 36-hour Singapore simulation added exactly 36 hours only to exposed shipments. All five route risk/count/delay summaries matched the retained shipment states; unrelated corridors were unchanged.
- Browser: route overview and drilldown, route-to-voyage links, browser Back and reload, source-labelled news, and desktop/phone layout.

Positions, itineraries and cargo in this demo are synthetic. Route lines are approximate, not official traffic lanes or verified AIS tracks. Carrier names and vessel operators are not supplied by this fixture and are not invented.
