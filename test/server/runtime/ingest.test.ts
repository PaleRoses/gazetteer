import { describe, expect, test } from 'bun:test';
import { Effect, Stream } from 'effect';
import type { FeedEvent } from '../../../src/server/ingest/frame';
import { rate, startIngest } from '../../../src/server/runtime/ingest';

const helsinki = { id: 'helsinki', coordinates: [24.95, 60.16] as const };
const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const events = (mmsi: number): readonly FeedEvent[] => [
  { kind: 'static', mmsi, shipType: 70 },
  { kind: 'position', frame: { mmsi, at: nowSeconds(), lat: 60.16, lon: 24.95, sogKnots: 0.1, cogDeg: null, navStatus: 5 } },
  { kind: 'position', frame: { mmsi: 230000000 + mmsi % 1000, at: nowSeconds(), lat: 61, lon: 25, sogKnots: 9, cogDeg: null, navStatus: 0 } },
  { kind: 'invalid' },
];

describe('the ingest runtime', () => {
  test('a finished feed stops the reader and leaves a status that tells what the core made of it', async () => {
    const runtime = startIngest({ areas: [helsinki], feed: Stream.fromIterable(events(230123456)), source: 'test feed' });
    await Effect.runPromise(Effect.sleep(50));
    expect(runtime.status()).toMatchObject({
      running: false, provenance: 'live', source: 'test feed', received: 2, invalid: 1, activeVessels: 2, trackedMmsi: 0, countedVessels: 1,
      areas: { helsinki: { berthed: 1, anchored: 0, approach: 0 } },
    });
    expect(runtime.status().lastMessageAt).not.toBeNull();
    await runtime.close();
  });

  test('the rate is messages over elapsed seconds, and zero when no time passed', () => {
    expect(rate({ at: 0, received: 0 }, { at: 5_000, received: 165 })).toBe(33);
    expect(rate({ at: 5_000, received: 10 }, { at: 5_000, received: 10 })).toBe(0);
  });
});

describe('the vessels view', () => {
  test('carries the live fixes of the last ten minutes with the source, and never more than the cap', async () => {
    const now = Math.floor(Date.now() / 1000);
    const feed = Stream.fromIterable<FeedEvent>([
      { kind: 'position', frame: { mmsi: 230000001, at: now, lat: 60.16, lon: 24.95, sogKnots: 0.1, cogDeg: 12, navStatus: 5 } },
      { kind: 'position', frame: { mmsi: 230000002, at: now - 700, lat: 60.5, lon: 25, sogKnots: 9, cogDeg: 90, navStatus: 0 } },
    ]);
    const runtime = startIngest({ areas: [helsinki], feed, source: 'test feed' });
    await Effect.runPromise(Effect.sleep(50));
    const view = runtime.vessels();
    expect(view).toMatchObject({ provider: 'digitraffic', source: 'test feed' });
    expect(view.vessels).toEqual([{ mmsi: 230000001, lon: 24.95, lat: 60.16, sog: 0.1, cog: 12, at: new Date(now * 1000).toISOString(), zone: { portId: 'helsinki', kind: 'berth' } }]);
    await runtime.close();
  });
});

describe('the vessels cap', () => {
  test('never lists more than 2,000 vessels, the newest arrivals first', async () => {
    const now = Math.floor(Date.now() / 1000);
    const feed = Stream.fromIterable<FeedEvent>(Array.from({ length: 2_100 }, (_, index) => ({ kind: 'position', frame: { mmsi: 240_000_000 + index, at: now, lat: 60.16, lon: 24.95, sogKnots: 5, cogDeg: null, navStatus: null } })));
    const runtime = startIngest({ areas: [helsinki], feed, source: 'test feed' });
    await Effect.runPromise(Effect.sleep(100));
    const { vessels } = runtime.vessels();
    expect(vessels).toHaveLength(2_000);
    expect(vessels[0]!.mmsi).toBe(240_002_099);
    await runtime.close();
  });
});
