import type { IngestRuntime } from '../runtime/ingest';

export type IngestFeed = Pick<IngestRuntime, 'status' | 'vessels'>;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } as const;

/** What the demo shows of the firehose: read-only, membership-free, counters and counts only (no vessel positions, no identities). */
const ingestView = (status: ReturnType<IngestFeed['status']> | undefined) => ({
  feeds: status === undefined ? [] : [{
    provider: 'digitraffic', live: status.running, msgPerSec: status.messagesPerSecond, trackedVessels: status.activeVessels, lastMessageAt: status.lastMessageAt,
    source: status.source, received: status.received, invalid: status.invalid, subscribedShips: status.trackedMmsi, countedVessels: status.countedVessels, unclassified: status.unclassified,
  }],
  zones: status === undefined ? [] : Object.entries(status.areas).map(([id, counts]) => ({ id, ...counts, provenance: 'radius-estimate', scope: 'all cargo and tanker traffic seen by the feed' })),
});

/** `GET /api/ingest`. */
export const createIngestHandler = (feed: () => IngestFeed | undefined) => (): Response =>
  Response.json(ingestView(feed()?.status()), { headers });

/** `GET /api/ingest/vessels`: the newest conflated fixes (bounded, last ten minutes) for the live-traffic layer. Public AIS data from an open feed; no workspace data. */
export const createVesselsHandler = (feed: () => IngestFeed | undefined) => (): Response =>
  Response.json(feed()?.vessels() ?? { provider: null, source: null, fetchedAt: new Date().toISOString(), vessels: [] }, { headers });
