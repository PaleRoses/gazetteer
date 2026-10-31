import { Effect, Fiber } from 'effect';
import { digitrafficFeed } from '../ingest/digitraffic';
import type { Counts } from '../ingest/anchorage';
import { view } from '../ingest/constants';
import { createIngest, type Ingest } from '../ingest/hub';
import { runIngest, type Feed } from '../ingest/pipeline';
import type { PortArea } from '../ingest/zones';

/** Ports inside Digitraffic's coverage: the live feed can only count where it has receivers. The demo catalogue's ports join when a feed covers them. */
const balticAreas: readonly PortArea[] = [
  { id: 'helsinki', coordinates: [24.95, 60.16] }, { id: 'kotka', coordinates: [26.95, 60.46] }, { id: 'hanko', coordinates: [22.95, 59.82] },
  { id: 'naantali', coordinates: [21.98, 60.46] }, { id: 'rauma', coordinates: [21.45, 61.13] }, { id: 'tallinn', coordinates: [24.77, 59.45] },
];

type IngestStatus = Readonly<{
  running: boolean; provenance: 'live'; source: string; startedAt: string; lastMessageAt: string | null;
  messagesPerSecond: number; received: number; invalid: number; activeVessels: number; trackedMmsi: number;
  countedVessels: number; unclassified: number; areas: Readonly<Record<string, Readonly<Counts>>>;
}>;

type IngestVessel = Readonly<{ mmsi: number; lon: number; lat: number; sog: number | null; cog: number | null; at: string; zone: Readonly<{ portId: string; kind: string }> | null }>;
type IngestVessels = Readonly<{ provider: string; source: string; fetchedAt: string; vessels: readonly IngestVessel[] }>;
export type IngestRuntime = Readonly<{ ingest: Ingest; status: () => IngestStatus; vessels: () => IngestVessels; close: () => Promise<void> }>;

/** Pure: messages per second over the window between two flush readings (times in milliseconds); 0 when no time has passed. */
export const rate = (previous: Readonly<{ at: number; received: number }>, now: Readonly<{ at: number; received: number }>): number =>
  now.at > previous.at ? Math.round(((now.received - previous.received) / ((now.at - previous.at) / 1000)) * 10) / 10 : 0;

/** Starts the one reader for this process. The feed is injectable so a test can drive it without a network. */
export const startIngest = (options: Readonly<{ areas?: readonly PortArea[]; feed?: Feed; source?: string; now?: () => number }> = {}): IngestRuntime => {
  const { areas = balticAreas, feed = digitrafficFeed(), source = 'Fintraffic Digitraffic marine AIS (MQTT, CC BY 4.0), Baltic Sea', now = Date.now } = options;
  const ingest = createIngest({ ports: areas });
  const startedAt = now();
  let last = { at: startedAt, received: 0 };
  let perSecond = 0;
  let lastMessageAt: number | null = null;
  let alive = true;
  const fiber = Effect.runFork(Effect.scoped(runIngest(feed, ingest, () => {
    const reading = { at: now(), received: ingest.stats().received };
    perSecond = rate(last, reading);
    if (reading.received > last.received) lastMessageAt = reading.at;
    last = reading;
  }, () => now() / 1000).pipe(Effect.ensuring(Effect.sync(() => { alive = false; })))));
  return {
    ingest,
    status: () => {
      const stats = ingest.stats();
      return {
        running: alive, provenance: 'live', source, startedAt: new Date(startedAt).toISOString(), lastMessageAt: lastMessageAt === null ? null : new Date(lastMessageAt).toISOString(),
        messagesPerSecond: perSecond, received: stats.received, invalid: stats.invalid, activeVessels: stats.active, trackedMmsi: stats.tracked,
        countedVessels: stats.vessels, unclassified: stats.unclassified, areas: Object.fromEntries(areas.map(area => [area.id, { ...ingest.counts(area.id) }])),
      };
    },
    vessels: () => ({
      provider: 'digitraffic', source, fetchedAt: new Date(now()).toISOString(),
      vessels: ingest.recent(now() / 1000, view.maxVessels, view.withinSeconds).map(({ frame, zone }) => ({
        mmsi: frame.mmsi, lon: frame.lon, lat: frame.lat, sog: frame.sogKnots, cog: frame.cogDeg, at: new Date(frame.at * 1000).toISOString(), zone: zone ?? null,
      })),
    }),
    close: () => Effect.runPromise(Fiber.interrupt(fiber)),
  };
};
