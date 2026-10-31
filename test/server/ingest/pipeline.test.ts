import { describe, expect, test } from 'bun:test';
import { Effect, Stream } from 'effect';
import { createIngest } from '../../../src/server/ingest/hub';
import { FeedError, runIngest, type Feed } from '../../../src/server/ingest/pipeline';
import type { FeedEvent } from '../../../src/server/ingest/frame';
import { at, frame, laPort } from './fixtures';

const events = (mmsi: number): readonly FeedEvent[] => [{ kind: 'static', mmsi, shipType: 70 }, { kind: 'position', frame: frame(mmsi, 1_000, at.berth) }];

describe('the reader', () => {
  test('applies every event of a feed to the core and flushes through the callback', async () => {
    const ingest = createIngest({ ports: [laPort] });
    const flushes: number[] = [];
    await Effect.runPromise(Effect.scoped(runIngest(Stream.fromIterable(events(367000020)), ingest, flush => { flushes.push(flush.traffic.length); }, () => 1_000)));
    expect(ingest.counts('los-angeles').berthed).toBe(1);
    expect(flushes.length).toBeGreaterThanOrEqual(1);
  });

  test('a feed that fails is retried on the reconnect schedule and its later events still arrive', async () => {
    const ingest = createIngest({ ports: [laPort] });
    let attempts = 0;
    const feed: Feed = Stream.suspend(() => {
      attempts += 1;
      return attempts === 1 ? Stream.fail(new FeedError({ reason: 'down' })) : Stream.fromIterable(events(367000021));
    });
    await Effect.runPromise(Effect.scoped(runIngest(feed, ingest, () => undefined, () => 1_000)));
    expect(attempts).toBe(2);
    expect(ingest.counts('los-angeles').berthed).toBe(1);
  });
});
