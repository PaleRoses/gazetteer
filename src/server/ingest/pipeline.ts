import { Data, Duration, Effect, Schedule, Stream, type Scope } from 'effect';
import type { FeedEvent } from './frame';
import type { Flush, Ingest } from './hub';

export class FeedError extends Data.TaggedError('FeedError')<{ readonly reason: string }> {}
export type Feed = Stream.Stream<FeedEvent, FeedError>;

/** Exponential from one second, jittered, capped at a minute: a feed that keeps failing is retried for as long as the process lives. */
const reconnectPolicy = Schedule.exponential('1 second').pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration }) => Effect.succeed(Duration.min(duration, Duration.seconds(60)))),
);

const flushIntervalMillis = 5_000;
export const feedBufferSize = 8_192;

/**
 * The one reader. The feed is retried on `reconnectPolicy`, events are applied to the core in arrival batches, a scoped fiber flushes on
 * the actor cadence, and a feed that ends (a replay) gets one last flush. Everything the core hands back (deliveries, port traffic) leaves through `onFlush`; the core never sees an Effect.
 */
export const runIngest = (
  feed: Feed, ingest: Ingest, onFlush: (flush: Flush) => void, clock: () => number = () => Date.now() / 1000,
): Effect.Effect<void, FeedError, Scope.Scope> =>
  Effect.gen(function* () {
    yield* Effect.forkScoped(Effect.repeat(Effect.sync(() => onFlush(ingest.flush(clock()))), Schedule.spaced(Duration.millis(flushIntervalMillis))));
    yield* Stream.runForEachArray(Stream.retry(feed, reconnectPolicy), events => Effect.sync(() => { events.forEach(ingest.push); }));
    yield* Effect.sync(() => { onFlush(ingest.flush(clock())); });
  });
