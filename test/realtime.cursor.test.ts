import { describe, expect, test } from 'bun:test';
import { advance, compareMessages, pollSince, type Cursor, type ListPage, type Message, type PageRequest, type Poll } from '../src/server/realtime/cursor';

type Fixture = Message & Readonly<{ n: number }>;
// Ids copied from the live probe of 2026-10-31 (monotonic 18-digit snowflakes, one every few seconds).
const base = 242369777357611008n;
const message = (n: number): Fixture => ({ n, messageId: String(base + BigInt(n) * 18_800_000_000n), createdAt: new Date(Date.UTC(2026, 9, 31, 19, 30, 57) + n * 4000).toISOString() });
const range = (from: number, to: number): readonly Fixture[] => Array.from({ length: Math.max(0, to - from) }, (_, index) => message(from + index));

/**
 * Relay list semantics as recorded by the probe: newest-first; `after` keeps only newer messages and still returns
 * the NEWEST `limit` of them; `before` bounds from above. Counts the calls made.
 */
const relayOf = (channel: () => readonly Fixture[]) => {
  const calls: PageRequest[] = [];
  const list: ListPage<Fixture> = async request => {
    calls.push(request);
    return channel()
      .filter(item => (request.after === undefined || BigInt(item.messageId) > BigInt(request.after)) && (request.before === undefined || BigInt(item.messageId) < BigInt(request.before)))
      .toSorted((left, right) => compareMessages(right, left))
      .slice(0, request.limit);
  };
  return { list, calls };
};
const seeded = (seed: number) => { let state = seed; return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32; };
const shuffled = <A>(values: readonly A[], random: () => number): readonly A[] => values.map(value => ({ value, key: random() })).toSorted((left, right) => left.key - right.key).map(entry => entry.value);
const numbers = (items: readonly Fixture[]): readonly number[] => items.map(item => item.n);

describe('compareMessages', () => {
  test('orders numeric ids by value, not by text', () => {
    expect(compareMessages({ messageId: '999' }, { messageId: '1000' })).toBeLessThan(0);
    expect(compareMessages({ messageId: '0042' }, { messageId: '42' })).toBe(0);
  });
  test('falls back to createdAt then id for non-numeric ids', () => {
    expect(compareMessages({ messageId: 'b', createdAt: '2026-10-31T10:00:00.000Z' }, { messageId: 'a', createdAt: '2026-10-31T11:00:00.000Z' })).toBeLessThan(0);
    expect(compareMessages({ messageId: 'a', createdAt: 'same' }, { messageId: 'b', createdAt: 'same' })).toBeLessThan(0);
  });
});

describe('advance', () => {
  test('yields the unseen messages oldest first and moves the cursor to the newest', () => {
    const step = advance(null, [message(3), message(1), message(2)]);
    expect(numbers(step.fresh)).toEqual([1, 2, 3]);
    expect(step.cursor?.messageId).toBe(message(3).messageId);
  });
  test('replaying a page is idempotent and never regresses the cursor', () => {
    const page = shuffled(range(0, 40), seeded(7));
    const first = advance(null, page);
    const again = advance(first.cursor, page);
    expect(again.fresh).toEqual([]);
    expect(again.cursor).toEqual(first.cursor);
    expect(advance(first.cursor, [message(2)]).cursor).toEqual(first.cursor);
  });
  test('the result does not depend on page order or duplicates', () => {
    const random = seeded(11);
    const cursor: Cursor = { messageId: message(9).messageId, createdAt: null };
    const reference = advance(cursor, range(0, 30));
    [1, 2, 3, 4, 5].forEach(() => {
      expect(advance(cursor, shuffled([...range(0, 30), ...range(20, 30)], random))).toEqual(reference);
    });
  });
  test('an empty page leaves the cursor alone', () => {
    const cursor: Cursor = { messageId: message(4).messageId, createdAt: null };
    expect(advance(cursor, [])).toEqual({ fresh: [], cursor });
  });
});

describe('pollSince against the recorded Relay list semantics', () => {
  test('the idle poll is one request and changes nothing', async () => {
    const relay = relayOf(() => range(0, 10));
    const first = await pollSince(relay.list, null, item => item);
    const callsAfterFirst = relay.calls.length;
    const idle = await pollSince(relay.list, first.cursor, item => item);
    expect(idle.items).toEqual([]);
    expect(idle.cursor).toEqual(first.cursor);
    expect(relay.calls.slice(callsAfterFirst)).toEqual([{ limit: 100, after: first.cursor?.messageId ?? undefined }]);
  });

  test('a gap larger than one page is walked down without skipping the middle (after alone would)', async () => {
    const channel = range(0, 30);
    const cursor: Cursor = { messageId: message(4).messageId, createdAt: null };
    const naive = await relayOf(() => channel).list({ limit: 10, after: message(4).messageId });
    expect(numbers(naive)).toEqual(numbers(range(20, 30)).toReversed());
    const poll = await pollSince(relayOf(() => channel).list, cursor, item => item, 10);
    expect(numbers(poll.items)).toEqual(numbers(range(5, 30)));
    expect(poll.complete).toBe(true);
  });

  test('a page exactly full still proves the gap closed with one more request', async () => {
    const relay = relayOf(() => range(0, 10));
    const poll = await pollSince(relay.list, null, item => item, 10);
    expect(poll.items).toHaveLength(10);
    expect(relay.calls).toHaveLength(2);
  });

  test('polling in random bursts and page sizes delivers every message exactly once, in order', async () => {
    const random = seeded(2026);
    for (const limit of [3, 7, 100]) {
      let channel: readonly Fixture[] = [];
      let cursor: Cursor | null = null;
      let delivered: readonly Fixture[] = [];
      for (let round = 0; round < 25; round += 1) {
        const burst = Math.floor(random() * 20);
        channel = [...channel, ...range(channel.length, channel.length + burst)];
        const poll: Poll<Fixture> = await pollSince(relayOf(() => channel).list, cursor, item => item, limit);
        expect(poll.complete).toBe(true);
        cursor = poll.cursor;
        delivered = [...delivered, ...poll.items];
      }
      expect(numbers(delivered)).toEqual(numbers(channel));
    }
  });

  test('extract decides what counts: skipped messages still advance the cursor', async () => {
    const poll = await pollSince(relayOf(() => range(0, 12)).list, null, item => (item.n % 4 === 0 ? item.n : undefined));
    expect(poll.items).toEqual([0, 4, 8]);
    expect(poll.cursor?.messageId).toBe(message(11).messageId);
  });

  test('an exhausted page budget releases nothing, keeps the confirmed position and resumes below its frontier', async () => {
    const channel = range(0, 40);
    const cursor: Cursor = { messageId: message(0).messageId, createdAt: null };
    const relay = relayOf(() => channel);
    const starved = await pollSince(relay.list, cursor, item => item, 5, 3);
    expect(starved.complete).toBe(false);
    expect(starved.items).toEqual([]);
    expect(starved.cursor?.messageId).toBe(cursor.messageId);
    expect(starved.cursor?.descent?.frontier).toBe(message(25).messageId);
    const second = relayOf(() => channel);
    const resumed = await pollSince(second.list, starved.cursor, item => item, 5, 3);
    expect(second.calls[0]).toEqual({ limit: 5, after: message(0).messageId, before: message(25).messageId });
    expect(resumed.complete).toBe(false);
  });

  test('a failing list propagates so the caller can leave the persisted cursor untouched', async () => {
    const failing: ListPage<Fixture> = async () => { throw new Error('relay down'); };
    await expect(pollSince(failing, null, item => item)).rejects.toThrow('relay down');
  });

  test('a gap of 12000 messages converges in ceil(12000 / budget) reads, losing nothing and duplicating nothing, even across a JSON round trip of the persisted cursor', async () => {
    const channel = range(0, 12001);
    const known: Cursor = { messageId: message(0).messageId, createdAt: null };
    const [limit, maxPages] = [100, 50];
    let cursor: Cursor | null = known;
    let reads = 0;
    let released: readonly Fixture[] = [];
    let complete = false;
    while (!complete) {
      const poll: Poll<Fixture> = await pollSince(relayOf(() => channel).list, cursor, item => item, limit, maxPages, value => value as Fixture);
      reads += 1;
      expect(reads).toBeLessThanOrEqual(Math.ceil(12000 / (limit * maxPages)));
      if (!poll.complete) expect(poll.items).toEqual([]);
      cursor = JSON.parse(JSON.stringify(poll.cursor)) as Cursor | null;
      released = [...released, ...poll.items];
      complete = poll.complete;
    }
    expect(reads).toBe(3);
    expect(numbers(released)).toEqual(numbers(range(1, 12001)));
    expect(cursor?.messageId).toBe(message(12000).messageId);
    expect(cursor?.descent).toBeUndefined();
  });

  test('a first read (no confirmed position) also descends in bounded steps', async () => {
    const channel = range(0, 450);
    let cursor: Cursor | null = null;
    let released: readonly Fixture[] = [];
    let reads = 0;
    for (let complete = false; !complete;) {
      const poll: Poll<Fixture> = await pollSince(relayOf(() => channel).list, cursor, item => item, 10, 20);
      cursor = poll.cursor; released = [...released, ...poll.items]; complete = poll.complete; reads += 1;
    }
    expect(reads).toBe(3);
    expect(numbers(released)).toEqual(numbers(channel));
  });

  test('messages arriving mid-descent are neither lost nor duplicated: they wait for the next read', async () => {
    let channel = range(0, 300);
    let cursor: Cursor | null = { messageId: message(0).messageId, createdAt: null };
    const first: Poll<Fixture> = await pollSince(relayOf(() => channel).list, cursor, item => item, 10, 5);
    expect(first.complete).toBe(false);
    channel = [...channel, ...range(300, 320)];
    cursor = first.cursor;
    let released: readonly Fixture[] = [];
    for (let complete = false; !complete;) {
      const poll: Poll<Fixture> = await pollSince(relayOf(() => channel).list, cursor, item => item, 10, 5);
      cursor = poll.cursor; released = [...released, ...poll.items]; complete = poll.complete;
    }
    const tail = await pollSince(relayOf(() => channel).list, cursor, item => item, 10, 5);
    expect(numbers([...released, ...tail.items])).toEqual(numbers(range(1, 320)));
  });

});
