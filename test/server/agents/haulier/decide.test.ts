import { describe, expect, test } from 'bun:test';
import { bookingKey, type RecoveryMessage } from '../../../../src/core/recovery';
import { emptyHaulierMemory, hear, truckResource, withdrawTruck, type HaulierContext, type HaulierMemory } from '../../../../src/server/agents/haulier/decide';
import type { Truck } from '../../../../src/server/agents/haulier/truck';
import { createBookings } from '../../../../src/server/booking/ledger';

const now = '2026-10-31T16:30:00.000Z';
const trucks: readonly Truck[] = [
  { id: 'rtm-1930', departs: '2026-10-31T19:30:00.000Z', priceEur: 240 },
  { id: 'rtm-1700', departs: '2026-10-31T17:00:00.000Z', priceEur: 210 },
  { id: 'rtm-2200', departs: '2026-10-31T22:00:00.000Z', priceEur: 260 },
];
const cargo = { role: 'cargo', id: 'cargo-1', vessel: 'Meridian Star' } as const;
const haulier = { role: 'haulier', city: 'rotterdam' } as const;
const request = (caseId: string, after?: string, id = `request:${caseId}:${after ?? 'first'}`): RecoveryMessage =>
  ({ id, kind: 'recovery.request', author: cargo, at: now, summary: 'A truck, please.', caseId, answers: [], to: haulier, service: 'truck', ...(after ? { after } : {}) });
const holdOf = (caseId: string, offerId: string, expiresAt = '2026-10-31T17:00:00.000Z'): RecoveryMessage =>
  ({ id: `hold:${caseId}:${offerId}`, kind: 'recovery.hold', author: cargo, at: now, summary: 'Holding.', caseId, answers: [`offer:${offerId}`], offerId, key: bookingKey(caseId, offerId), expiresAt });
const fresh = (at = now) => {
  const time = { ms: Date.parse(at) };
  const ledger = createBookings(':memory:', () => time.ms);
  const context = (overrides: Partial<HaulierContext> = {}): HaulierContext => ({ city: 'rotterdam', workspaceId: 'w1', trucks, now: new Date(time.ms).toISOString(), ledger, ...overrides });
  return { ledger, context, time };
};
const offers = (posts: readonly RecoveryMessage[]) => posts.flatMap(post => post.kind === 'recovery.offer' ? [post.offer] : []);

describe('answering a request', () => {
  test('offers the earliest truck that has not left, and a later one when asked for a later one', () => {
    const { context } = fresh();
    const first = hear(context(), emptyHaulierMemory, [request('case-1')]);
    expect(offers(first.posts)).toMatchObject([{ service: 'truck', id: 'truck:rtm-1700:case-1', departs: '2026-10-31T17:00:00.000Z', priceEur: 210, provider: haulier, expiresAt: '2026-10-31T17:00:00.000Z' }]);
    const later = hear(context(), first.memory, [request('case-1', '2026-10-31T18:00:00.000Z')]);
    expect(offers(later.posts)).toMatchObject([{ id: 'truck:rtm-1930:case-1', departs: '2026-10-31T19:30:00.000Z' }]);
    expect(later.posts[0]).toMatchObject({ kind: 'recovery.offer', caseId: 'case-1', answers: ['request:case-1:2026-10-31T18:00:00.000Z'], author: haulier });
  });

  test('a truck that has already left is never offered', () => {
    const { context } = fresh('2026-10-31T17:30:00.000Z');
    expect(offers(hear(context(), emptyHaulierMemory, [request('case-1')]).posts)[0]?.id).toBe('truck:rtm-1930:case-1');
  });

  test('a replayed board is answered once; messages for another city or service are ignored', () => {
    const { context } = fresh();
    const once = hear(context(), emptyHaulierMemory, [request('case-1')]);
    expect(hear(context(), once.memory, [request('case-1')]).posts).toEqual([]);
    const elsewhere = { ...request('case-2'), to: { role: 'haulier', city: 'antwerp' } } as RecoveryMessage;
    const storage = { ...request('case-3'), service: 'storage' } as RecoveryMessage;
    expect(hear(context(), emptyHaulierMemory, [elsewhere, storage]).posts).toEqual([]);
  });

  test('a truck another case holds is not offered', () => {
    const { context, ledger } = fresh();
    ledger.hold({ key: 'other', workspaceId: 'w1', caseId: 'case-9', resource: truckResource('rotterdam', 'rtm-1700'), start: '2026-10-31T17:00:00.000Z', end: '2026-10-31T18:00:00.000Z', priceEur: 210, expiresAt: '2026-10-31T17:00:00.000Z', heldBy: 'x' });
    expect(offers(hear(context(), emptyHaulierMemory, [request('case-1')]).posts)[0]?.id).toBe('truck:rtm-1930:case-1');
  });

  test('says nothing when it has no truck to give', () => {
    const { context } = fresh();
    expect(hear(context({ trucks: [] }), emptyHaulierMemory, [request('case-1')]).posts).toEqual([]);
  });
});

describe('holds, confirms and releases', () => {
  const offered = (): { memory: HaulierMemory; offerId: string } & ReturnType<typeof fresh> => {
    const world = fresh();
    const answered = hear(world.context(), emptyHaulierMemory, [request('case-1')]);
    return { ...world, memory: answered.memory, offerId: offers(answered.posts)[0]!.id };
  };

  test('a hold on the offer is recorded in the ledger, once, under the cargo agent\'s key', () => {
    const { context, memory, offerId, ledger } = offered();
    const message = holdOf('case-1', offerId);
    const held = hear(context(), memory, [message]);
    expect(held.posts).toEqual([]);
    expect(ledger.find(bookingKey('case-1', offerId))).toMatchObject({ status: 'held', resource: 'rotterdam:truck:rtm-1700', priceEur: 210, heldBy: 'haulier:rotterdam', caseId: 'case-1' });
    hear(context(), held.memory, [{ ...message, id: 'hold:again' }]);
    expect(ledger.list('w1')).toHaveLength(1);
  });

  test('a confirm makes the booking confirmed; a release frees the truck', () => {
    const { context, memory, offerId, ledger } = offered();
    const held = hear(context(), memory, [holdOf('case-1', offerId)]);
    const key = bookingKey('case-1', offerId);
    const confirm: RecoveryMessage = { id: 'confirm:1', kind: 'recovery.confirm', author: cargo, at: now, summary: 'Confirm.', caseId: 'case-1', answers: [], offerId, key };
    const confirmed = hear(context(), held.memory, [confirm]);
    expect(ledger.find(key)?.status).toBe('confirmed');
    hear(context(), confirmed.memory, [{ id: 'release:1', kind: 'recovery.release', author: cargo, at: now, summary: 'Release.', caseId: 'case-1', answers: [], offerId, key }]);
    expect(ledger.find(key)?.status).toBe('released');
    expect(ledger.free(truckResource('rotterdam', 'rtm-1700'), '2026-10-31T17:00:00.000Z', '2026-10-31T18:00:00.000Z')).toBe(true);
  });

  test('a confirm after the hold lapsed makes the haulier withdraw the offer, and says why', () => {
    const { context, memory, offerId, ledger, time } = offered();
    const held = hear(context(), memory, [holdOf('case-1', offerId, '2026-10-31T16:45:00.000Z')]);
    time.ms += 20 * 60_000;
    const key = bookingKey('case-1', offerId);
    const late = hear(context(), held.memory, [{ id: 'confirm:late', kind: 'recovery.confirm', author: cargo, at: now, summary: 'Confirm.', caseId: 'case-1', answers: [], offerId, key }]);
    expect(late.posts).toMatchObject([{ kind: 'recovery.withdraw', offerId, reason: 'the hold expired before it was confirmed' }]);
    expect(ledger.find(key)?.status).toBe('expired');
  });

  test('a hold on an offer that has expired, or on a truck taken meanwhile, is answered with a withdrawal', () => {
    const { context, memory, offerId, ledger } = offered();
    ledger.hold({ key: 'other', workspaceId: 'w1', caseId: 'case-9', resource: truckResource('rotterdam', 'rtm-1700'), start: '2026-10-31T17:00:00.000Z', end: '2026-10-31T18:00:00.000Z', priceEur: 210, expiresAt: '2026-10-31T16:50:00.000Z', heldBy: 'x' });
    const taken = hear(context(), memory, [holdOf('case-1', offerId, '2026-10-31T16:45:00.000Z')]);
    expect(taken.posts).toMatchObject([{ kind: 'recovery.withdraw', reason: 'the truck is already held for another case' }]);
    const stale = fresh();
    const answered = hear(stale.context(), emptyHaulierMemory, [request('case-1')]);
    stale.time.ms += 40 * 60_000;
    const expired = hear(stale.context(), answered.memory, [holdOf('case-1', offers(answered.posts)[0]!.id, '2026-10-31T18:00:00.000Z')]);
    expect(expired.posts).toMatchObject([{ kind: 'recovery.withdraw', reason: 'the offer had expired before it was held' }]);
  });
});

describe('withdrawing a truck', () => {
  test('releases what the ledger holds for it, posts the withdrawal citing the offer, and is a no-op once done', () => {
    const world = fresh();
    const first = hear(world.context(), emptyHaulierMemory, [request('case-1')]);
    const second = hear(world.context(), first.memory, [request('case-1', '2026-10-31T18:00:00.000Z')]);
    const offerId = offers(second.posts)[0]!.id;
    const held = hear(world.context(), second.memory, [holdOf('case-1', offerId)]);
    const done = withdrawTruck(world.context(), held.memory, 'Simulated: withdrawn by the demo control.');
    expect(done.withdrawn?.offer.id).toBe(offerId);
    expect(done.posts).toMatchObject([{ kind: 'recovery.withdraw', offerId, caseId: 'case-1', answers: [`offer:${offerId}`], reason: 'Simulated: withdrawn by the demo control.' }]);
    expect(world.ledger.find(bookingKey('case-1', offerId))?.status).toBe('released');
    expect(done.memory.offers[offerId]?.status).toBe('withdrawn');
    expect(done.memory.offers['truck:rtm-1700:case-1']?.status).toBe('open');
    const again = withdrawTruck(world.context(), done.memory, 'x', offerId);
    expect(again).toMatchObject({ posts: [], withdrawn: null });
  });
});
