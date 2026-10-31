import { describe, expect, test } from 'bun:test';
import { createBookings, type HoldInput } from '../../../src/server/booking/ledger';

const t0 = Date.parse('2026-10-31T16:00:00.000Z');
const clock = (start = t0) => { let current = start; return { now: () => current, advance: (millis: number) => { current += millis; } }; };
const terms = (overrides: Partial<HoldInput> = {}): HoldInput => ({
  key: 'case-1:reefer-a', workspaceId: 'w1', caseId: 'case-1', resource: 'rotterdam:reefer-12',
  start: '2026-10-31T18:00:00.000Z', end: '2026-10-31T22:00:00.000Z', priceEur: 180.5, expiresAt: '2026-10-31T16:30:00.000Z', heldBy: 'cargo:meridian-star', ...overrides,
});
const fresh = (time = clock()) => ({ time, ledger: createBookings(':memory:', time.now) });
const value = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => { if (!result.ok) throw new Error(result.error); return result.value; };

describe('hold', () => {
  test('a double hold with the same key is one record', () => {
    const { ledger } = fresh();
    const first = value(ledger.hold(terms()));
    const second = value(ledger.hold(terms()));
    expect(second.id).toBe(first.id);
    expect(ledger.list('w1')).toHaveLength(1);
    expect(first).toMatchObject({ status: 'held', priceEur: 180.5, heldBy: 'cargo:meridian-star', confirmedAt: null });
  });

  test('the same key with other terms is refused, and never rewrites the record', () => {
    const { ledger } = fresh();
    const first = value(ledger.hold(terms()));
    expect(ledger.hold(terms({ priceEur: 99 }))).toEqual({ ok: false, error: 'key_conflict' });
    expect(ledger.get(first.id)!.priceEur).toBe(180.5);
  });

  test('a retry after the confirm returns the confirmed record, not a second hold', () => {
    const { ledger } = fresh();
    const held = value(ledger.hold(terms()));
    value(ledger.confirm(held.id));
    expect(value(ledger.hold(terms()))).toMatchObject({ id: held.id, status: 'confirmed' });
  });

  test('a resource cannot be held over a window that overlaps a live hold or a confirmed booking, but can be once the hold lapses or is released', () => {
    const { ledger, time } = fresh();
    const first = value(ledger.hold(terms()));
    const overlapping = terms({ key: 'case-2:reefer', caseId: 'case-2', start: '2026-10-31T21:00:00.000Z', end: '2026-10-31T22:00:00.000Z' });
    expect(ledger.hold(overlapping)).toEqual({ ok: false, error: 'resource_taken' });
    expect(ledger.hold(terms({ key: 'case-2:adjacent', caseId: 'case-2', start: '2026-10-31T22:00:00.000Z', end: '2026-11-01T01:00:00.000Z' })).ok).toBe(true);
    value(ledger.release(first.id));
    expect(ledger.hold(overlapping).ok).toBe(true);
    time.advance(31 * 60_000);
    expect(ledger.hold({ ...overlapping, key: 'case-3:reefer', caseId: 'case-3', expiresAt: '2026-10-31T17:00:00.000Z' }).ok).toBe(true);
  });

  test('rejects an inverted window, a negative price, and a hold that is already expired', () => {
    const { ledger } = fresh();
    expect(ledger.hold(terms({ start: '2026-10-31T22:00:00.000Z', end: '2026-10-31T18:00:00.000Z' }))).toEqual({ ok: false, error: 'invalid_input' });
    expect(ledger.hold(terms({ priceEur: -1 }))).toEqual({ ok: false, error: 'invalid_input' });
    expect(ledger.hold(terms({ expiresAt: '2026-10-31T15:59:00.000Z' }))).toEqual({ ok: false, error: 'invalid_input' });
  });
});

describe('confirm', () => {
  test('is idempotent and keeps the first confirmation time', () => {
    const { ledger, time } = fresh();
    const held = value(ledger.hold(terms()));
    const confirmed = value(ledger.confirm(held.id));
    time.advance(60_000);
    expect(value(ledger.confirm(held.id))).toEqual(confirmed);
    expect(confirmed).toMatchObject({ status: 'confirmed', confirmedAt: '2026-10-31T16:00:00.000Z' });
  });

  test('after expiry is refused, and the record reads expired', () => {
    const { ledger, time } = fresh();
    const held = value(ledger.hold(terms()));
    time.advance(30 * 60_000);
    expect(ledger.confirm(held.id)).toEqual({ ok: false, error: 'expired' });
    expect(ledger.get(held.id)!.status).toBe('expired');
    expect(ledger.confirm(held.id)).toEqual({ ok: false, error: 'expired' });
  });

  test('a released hold cannot be confirmed; an unknown id is not found', () => {
    const { ledger } = fresh();
    const held = value(ledger.hold(terms()));
    value(ledger.release(held.id));
    expect(ledger.confirm(held.id)).toEqual({ ok: false, error: 'not_held' });
    expect(ledger.confirm('bk_nothing')).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('release', () => {
  test('is idempotent', () => {
    const { ledger, time } = fresh();
    const held = value(ledger.hold(terms()));
    const first = value(ledger.release(held.id));
    time.advance(5_000);
    expect(value(ledger.release(held.id))).toEqual(first);
    expect(first.status).toBe('released');
  });

  test('cancels a confirmed booking; an expired hold stays expired', () => {
    const { ledger, time } = fresh();
    const confirmed = value(ledger.confirm(value(ledger.hold(terms())).id));
    expect(value(ledger.release(confirmed.id)).status).toBe('released');
    const lapsing = value(ledger.hold(terms({ key: 'k2', resource: 'rotterdam:truck-3' })));
    time.advance(31 * 60_000);
    expect(value(ledger.release(lapsing.id)).status).toBe('expired');
  });
});

describe('lookup', () => {
  test('find returns the record a key made, and free tells whether a window is open', () => {
    const { ledger, time } = fresh();
    const held = value(ledger.hold(terms()));
    expect(ledger.find('case-1:reefer-a')).toEqual(held);
    expect(ledger.find('nothing')).toBeUndefined();
    expect(ledger.free('rotterdam:reefer-12', '2026-10-31T19:00:00.000Z', '2026-10-31T20:00:00.000Z')).toBe(false);
    expect(ledger.free('rotterdam:reefer-12', '2026-10-31T22:00:00.000Z', '2026-10-31T23:00:00.000Z')).toBe(true);
    time.advance(31 * 60_000);
    expect(ledger.free('rotterdam:reefer-12', '2026-10-31T19:00:00.000Z', '2026-10-31T20:00:00.000Z')).toBe(true);
    expect(ledger.find('case-1:reefer-a')!.status).toBe('expired');
  });
});

describe('expiry and listing', () => {
  test('the sweep records expiry once and leaves confirmed bookings alone', () => {
    const { ledger, time } = fresh();
    const confirmed = value(ledger.confirm(value(ledger.hold(terms())).id));
    value(ledger.hold(terms({ key: 'k2', resource: 'rotterdam:truck-3' })));
    value(ledger.hold(terms({ key: 'k3', resource: 'rotterdam:truck-4', expiresAt: '2026-10-31T20:00:00.000Z' })));
    time.advance(31 * 60_000);
    expect(ledger.sweep()).toBe(1);
    expect(ledger.sweep()).toBe(0);
    expect(ledger.list('w1').map(booking => booking.status).sort()).toEqual(['confirmed', 'expired', 'held']);
    expect(ledger.get(confirmed.id)!.status).toBe('confirmed');
  });

  test('a workspace sees only its own records, in start order, linked by case', () => {
    const { ledger } = fresh();
    value(ledger.hold(terms({ key: 'a', resource: 'r1', start: '2026-10-31T20:00:00.000Z', end: '2026-10-31T21:00:00.000Z' })));
    value(ledger.hold(terms({ key: 'b', resource: 'r2', start: '2026-10-31T17:00:00.000Z', end: '2026-10-31T18:00:00.000Z' })));
    value(ledger.hold(terms({ key: 'c', workspaceId: 'w2', resource: 'r3' })));
    expect(ledger.list('w1').map(booking => booking.resource)).toEqual(['r2', 'r1']);
    expect(ledger.list('w2')).toHaveLength(1);
    expect(ledger.list('nobody')).toEqual([]);
  });

  test('survives a reopen: the file is the state', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/gazetteer-ledger-${crypto.randomUUID()}.sqlite`;
    const time = clock();
    const first = createBookings(path, time.now);
    const held = value(first.hold(terms()));
    first.close();
    const second = createBookings(path, time.now);
    expect(value(second.hold(terms())).id).toBe(held.id);
    second.close();
    await Bun.file(path).delete();
  });
});
