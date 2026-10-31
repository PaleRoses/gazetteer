import type { IngestStatus } from '../runtime/ingest';

/** What the demo shows of the firehose: read-only, membership-free, counters and counts only (no vessel positions, no identities). */
const ingestView = (status: IngestStatus | undefined) => ({
  feeds: status === undefined ? [] : [{
    provider: 'digitraffic', live: status.running, msgPerSec: status.messagesPerSecond, trackedVessels: status.activeVessels, lastMessageAt: status.lastMessageAt,
    source: status.source, received: status.received, invalid: status.invalid, subscribedShips: status.trackedMmsi, countedVessels: status.countedVessels, unclassified: status.unclassified,
  }],
  zones: status === undefined ? [] : Object.entries(status.areas).map(([id, counts]) => ({ id, ...counts, provenance: 'radius-estimate', scope: 'all cargo and tanker traffic seen by the feed' })),
});

/** `GET /api/ingest`. */
export const createIngestHandler = (status: () => IngestStatus | undefined) => (): Response =>
  Response.json(ingestView(status()), { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
