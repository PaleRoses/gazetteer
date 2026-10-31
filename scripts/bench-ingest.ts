/**
 * Replays one real day of US AIS (NOAA MarineCadastre) through the exact ingest hot path at maximum speed and reports what it cost.
 *   bun scripts/bench-ingest.ts [csv] [--rows N]
 * DuckDB reads and time-orders the CSV (no hand-written parser); every row becomes a FeedEvent, goes through Ingest.push, and the core is
 * flushed on a virtual 5 s event-time clock so deliveries have production cadence. Reported time covers event construction plus push.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import { createIngest, type Subscriber } from '../src/server/ingest/hub';
import type { FeedEvent } from '../src/server/ingest/frame';
import type { PortArea } from '../src/server/ingest/zones';

const args = process.argv.slice(2);
const rowsFlag = args.indexOf('--rows');
const rowLimit = rowsFlag >= 0 ? Number(args[rowsFlag + 1]) : Infinity;
const csv = args.find((arg, index) => !arg.startsWith('--') && index !== rowsFlag + 1) ?? '/Volumes/Sirius/work/gazetteer-data/marinecadastre/AIS_2023_06_15.csv';
const trackedPerGroup = 500;
const flushSeconds = 5;
const rssEveryRows = 1_000_000;

const ports: readonly PortArea[] = [
  { id: 'los-angeles', coordinates: [-118.26, 33.74] }, { id: 'oakland', coordinates: [-122.33, 37.8] }, { id: 'seattle', coordinates: [-122.35, 47.6] },
  { id: 'houston', coordinates: [-95.0, 29.6] }, { id: 'new-york', coordinates: [-74.05, 40.65] }, { id: 'savannah', coordinates: [-80.9, 32.1] },
  { id: 'singapore', coordinates: [103.82, 1.26] }, { id: 'rotterdam', coordinates: [4.48, 51.92] }, { id: 'shanghai', coordinates: [121.5, 31.2] },
];

const instance = await DuckDBInstance.create(':memory:');
const db = await instance.connect();
const source = `read_csv('${csv.replaceAll("'", "''")}')`;
const cargoTanker = 'VesselType between 70 and 89';
const ids = async (sql: string): Promise<readonly number[]> => (await db.runAndReadAll(sql)).getRows().map(row => Number(row[0]));
const nearLa = await ids(`select MMSI from (select distinct MMSI from ${source} where ${cargoTanker} and LAT between 33.5 and 33.9 and LON between -118.5 and -118.0) order by hash(MMSI) limit ${trackedPerGroup}`);
const anywhere = await ids(`select MMSI from (select distinct MMSI from ${source} where ${cargoTanker}) order by hash(MMSI) limit ${trackedPerGroup}`);
const tracked = [...new Set([...nearLa, ...anywhere])];

const ingest = createIngest({ ports });
tracked.forEach((mmsi, index) => { const subscriber: Subscriber = { workspaceId: 'bench', shipmentId: `s${index}` }; ingest.track(mmsi, subscriber); });
const trackedSet = new Set(tracked);

const bucketNanos = 100;
const histogram = new Uint32Array(20_000);
const overheadNanos = (() => {
  const start = performance.now();
  Array.from({ length: 1_000_000 }, () => performance.now());
  return ((performance.now() - start) * 1e6) / 1_000_000;
})();

const sentinel = (value: number, limit: number): number | null => value >= limit ? null : value;
const typed = new Set<number>();
const rssSamples: number[] = [];
const heapSamples: number[] = [];
const tally = { rows: 0, deliveries: 0, traffic: 0, trackedFrames: 0, flushes: 0, touchedPerFlush: 0, pushNanos: 0, flushNanos: 0 };
const touched = new Set<number>();
const laByHour: Record<string, unknown>[] = [];
let nextFlush = -Infinity;
let nextHour = -Infinity;
let maxNanos = 0;

const result = await db.stream(`select MMSI, epoch(BaseDateTime) as at, LAT, LON, SOG, COG, Status, VesselType from ${source} order by BaseDateTime`);
const wallStart = performance.now();
let readMillis = 0;
let mark = performance.now();
for await (const rows of result.yieldRows()) {
  readMillis += performance.now() - mark;
  for (const row of rows) {
    if (tally.rows >= rowLimit) break;
    const mmsi = Number(row[0]);
    const at = Number(row[1]);
    const t0 = performance.now();
    if (!typed.has(mmsi)) {
      typed.add(mmsi);
      if (row[7] !== null) ingest.push({ kind: 'static', mmsi, shipType: Number(row[7]) });
    }
    const event: FeedEvent = { kind: 'position', frame: { mmsi, at, lat: Number(row[2]), lon: Number(row[3]), sogKnots: sentinel(Number(row[4]), 102.3), cogDeg: sentinel(Number(row[5]), 360), navStatus: row[6] === null || Number(row[6]) === 15 ? null : Number(row[6]) } };
    ingest.push(event);
    const nanos = (performance.now() - t0) * 1e6;
    tally.pushNanos += nanos;
    maxNanos = Math.max(maxNanos, nanos);
    histogram[Math.min(histogram.length - 1, Math.floor(nanos / bucketNanos))]! += 1;
    tally.rows += 1;
    if (trackedSet.has(mmsi)) { tally.trackedFrames += 1; touched.add(mmsi); }
    if (at >= nextFlush) {
      const f0 = performance.now();
      const flush = ingest.flush(at);
      tally.flushNanos += (performance.now() - f0) * 1e6;
      tally.flushes += 1; tally.deliveries += flush.deliveries.reduce((sum, d) => sum + d.subscribers.length, 0); tally.traffic += flush.traffic.length; tally.touchedPerFlush += touched.size;
      touched.clear();
      nextFlush = at + flushSeconds;
      if (at >= nextHour) { laByHour.push({ t: new Date(at * 1000).toISOString().slice(11, 16), ...ingest.counts('los-angeles') }); nextHour = at + 3600; }
    }
    if (tally.rows % rssEveryRows === 0) { Bun.gc(true); const usage = process.memoryUsage(); rssSamples.push(Math.round(usage.rss / 2 ** 20)); heapSamples.push(Math.round(usage.heapUsed / 2 ** 20)); }
  }
  if (tally.rows >= rowLimit) break;
  mark = performance.now();
}
const wallSeconds = (performance.now() - wallStart) / 1000;

const percentile = (p: number): number => {
  const target = Math.ceil(tally.rows * p);
  const bucket = histogram.reduce<{ seen: number; at: number }>((state, count, index) => state.at >= 0 ? state : state.seen + count >= target ? { seen: state.seen + count, at: index } : { seen: state.seen + count, at: -1 }, { seen: 0, at: -1 }).at;
  return Math.max(0, (bucket + 1) * bucketNanos - overheadNanos);
};
const adjustedPushSeconds = Math.max(1e-9, (tally.pushNanos - overheadNanos * tally.rows) / 1e9);
const quarter = Math.floor(rssSamples.length / 4);
const lastQuarter = rssSamples.slice(-Math.max(2, quarter));
console.log(JSON.stringify({
  csv, rows: tally.rows, vessels: typed.size, tracked: tracked.length,
  msgPerSecondOneCore: Math.round(tally.rows / adjustedPushSeconds),
  pushSeconds: +adjustedPushSeconds.toFixed(2), flushSeconds: +(tally.flushNanos / 1e9).toFixed(3), duckdbReadSeconds: +(readMillis / 1000).toFixed(1), wallSeconds: +wallSeconds.toFixed(1),
  latencyMicros: { p50: percentile(0.5) / 1000, p99: percentile(0.99) / 1000, p999: percentile(0.999) / 1000, max: Math.round(maxNanos / 1000), timerOverheadNanos: Math.round(overheadNanos) },
  rssMiB: { samples: rssSamples.length, first: rssSamples[0], peak: Math.max(...rssSamples), last: rssSamples.at(-1), lastQuarterSpread: lastQuarter.length ? Math.max(...lastQuarter) - Math.min(...lastQuarter) : null, note: 'rss includes DuckDB, which holds the sorted day' },
  heapMiB: { samples: heapSamples, lastQuarterSpread: Math.max(...heapSamples.slice(-lastQuarter.length)) - Math.min(...heapSamples.slice(-lastQuarter.length)) },
  deliveries: { count: tally.deliveries, per1kMessages: +(tally.deliveries / tally.rows * 1000).toFixed(3), trackedFrames: tally.trackedFrames, ungatedConflatedPerFlush: tally.touchedPerFlush, trafficSnapshots: tally.traffic, flushes: tally.flushes },
  stats: ingest.stats(), losAngelesAnchoredByHour: laByHour,
}, null, 1));
await Bun.sleep(0);
process.exit(0);
