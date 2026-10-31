/**
 * Runs the real ingest pipeline on the live Digitraffic MQTT stream (keyless, Baltic) for a while and prints what the core made of it.
 *   bun scripts/probe-ingest.ts [seconds]
 */
import { Duration, Effect, Fiber } from 'effect';
import { digitrafficFeed } from '../src/server/ingest/digitraffic';
import { createIngest } from '../src/server/ingest/hub';
import { runIngest } from '../src/server/ingest/pipeline';
import type { PortArea } from '../src/server/ingest/zones';

const seconds = Number(process.argv[2]) || 30;
const ports: readonly PortArea[] = [
  { id: 'helsinki', coordinates: [24.95, 60.16] }, { id: 'kotka', coordinates: [26.95, 60.46] }, { id: 'hanko', coordinates: [22.95, 59.82] },
  { id: 'naantali', coordinates: [21.98, 60.46] }, { id: 'rauma', coordinates: [21.45, 61.13] }, { id: 'tallinn', coordinates: [24.77, 59.45] },
];
const ingest = createIngest({ ports });
const started = Date.now();
const flushes: { deliveries: number; traffic: number }[] = [];

const program = Effect.scoped(Effect.gen(function* () {
  const fiber = yield* Effect.forkScoped(runIngest(digitrafficFeed(), ingest, flush => { flushes.push({ deliveries: flush.deliveries.length, traffic: flush.traffic.length }); }));
  yield* Effect.sleep(Duration.seconds(seconds));
  yield* Fiber.interrupt(fiber);
}));
await Effect.runPromise(program);

const elapsed = (Date.now() - started) / 1000;
console.log(JSON.stringify({
  seconds: +elapsed.toFixed(1), stats: ingest.stats(), msgPerSecond: +(ingest.stats().received / elapsed).toFixed(1),
  ports: Object.fromEntries(ports.map(port => [port.id, ingest.counts(port.id)])), flushes: flushes.length,
}, null, 1));
process.exit(0);
