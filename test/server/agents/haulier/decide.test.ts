import { describe, expect, test } from 'bun:test';
import { bookingKey, type RecoveryMessage } from '../../../../src/core/recovery';
import { emptyHaulierMemory, hear, truckOfferId, withdrawTruck, type HaulierContext } from '../../../../src/server/agents/haulier/decide';
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
const offerFor = (id: string) => truckOfferId('rotterdam', id);
const fresh = () => {
  const time = { ms: Date.parse(now) };
  const ledger = createBookings(':memory:', () => time.ms);
  const context = (overrides: Partial<HaulierContext> = {}): HaulierContext => ({ city: 'rotterdam', workspaceId: 'w1', trucks, now: new Date(time.ms).toISOString(), ledger, ...overrides });
  return { ledger, context, time };
};
const holdOf = (caseId: string, offerId: string, expiresAt = '2026-10-31T17:00:00.000Z', id = `hold:${caseId}:${offerId}`): RecoveryMessage =>
  ({ id, kind: 'recovery.hold', author: cargo, at: now, summary: 'Holding.', caseId, answers: [], offerId, key: bookingKey(caseId, offerId), expiresAt });
const settleOf = (kind: 'recovery.confirm' | 'recovery.release', caseId: string, offerId: string, id = `${kind}:${caseId}:${offerId}`): RecoveryMessage =>
  ({ id, kind, author: cargo, at: now, summary: 'Settling.', caseId, answers: [], offerId, key: bookingKey(caseId, offerId) });
const offers = (posts: readonly RecoveryMessage[]) => posts.flatMap(post => post.kind === 'recovery.offer' ? [post.offer] : []);

describe('answering a request', () => {
  test('offers the earliest truck that has not left, and a later one when asked for a later one', () => {
    const { context } = fresh();
    const first = hear(context(), emptyHaulierMemory, [request('case-1')]);
    expect(offers(first.posts)).toMatchObject([{ service: 'truck', id: 'rotterdam:truck:rtm-1700', departs: '2026-10-31T17:00:00.000Z', priceEur: 210, provider: haulier, expiresAt: '2026-10-31T17:00:00.000Z' }]);
    const later = hear(context(), first.memory, [request('case-1', '2026-10-31T18:00:00.000Z')]);
    expect(offers(later.posts)).toMatchObject([{ id: 'rotterdam:truck:rtm-1930', departs: '2026-10-31T19:30:00.000Z' }]);
    expect(later.posts[0]).toMatchObject({ kind: 'recovery.offer', caseId: 'case-1', answers: ['request:case-1:2026-10-31T18:00:00.000Z'], author: haulier });
  });

  test('a truck that has already left is never offered', () => {
    const { context } = fresh();
    expect(offers(hear(context({ now: '2026-10-31T17:30:00.000Z' }), emptyHaulierMemory, [request('case-1')]).posts)[0]?.id).toBe(offerFor('rtm-1930'));
  });

  test('a replayed board is answered once; messages for another city or service are ignored', () => {
    const { context } = fresh();
    const once = hear(context(), emptyHaulierMemory, [request('case-1')]);
    expect(hear(context(), once.memory, [request('case-1')]).posts).toEqual([]);
    const elsewhere = { ...request('case-2'), to: { role: 'haulier', city: 'antwerp' } } as RecoveryMessage;
    const storage = { ...request('case-3'), service: 'storage' } as RecoveryMessage;
    expect(hear(context(), emptyHaulierMemory, [elsewhere, storage]).posts).toEqual([]);
  });

  test('the same truck can be offered to two cases, under distinct message ids', () => {
    const { context } = fresh();
    const one = hear(context(), emptyHaulierMemory, [request('case-1')]);
    const two = hear(context(), one.memory, [request('case-2')]);
    expect(offers(two.posts)[0]?.id).toBe(offerFor('rtm-1700'));
    expect(new Set([one.posts[0]!.id, two.posts[0]!.id]).size).toBe(2);
  });

  test('a truck the ledger already holds for a case is not offered to another', () => {
    const { context } = fresh();
    const first = hear(context(), emptyHaulierMemory, [request('case-9')]);
    const held = hear(context(), first.memory, [holdOf('case-9', offerFor('rtm-1700'))]);
    expect(offers(hear(context(), held.memory, [request('case-1')]).posts)[0]?.id).toBe(offerFor('rtm-1930'));
  });

  test('says nothing when it has no truck to give', () => {
    const { context } = fresh();
    expect(hear(context({ trucks: [] }), emptyHaulierMemory, [request('case-1')]).posts).toEqual([]);
  });
});

describe('writing the ledger for the holds, confirms and releases it hears', () => {
  const offered = () => {
    const world = fresh();
    const answered = hear(world.context(), emptyHaulierMemory, [request('case-1')]);
    return { ...world, memory: answered.memory, offerId: offers(answered.posts)[0]!.id, key: bookingKey('case-1', offerFor('rtm-1700')) };
  };

  test('a cargo hold leads to a ledger row under the cargo\'s key, the truck as the resource', () => {
    const { context, memory, offerId, key, ledger } = offered();
    const held = hear(context(), memory, [holdOf('case-1', offerId)]);
    expect(held.posts).toEqual([]);
    expect(ledger.find(key)).toMatchObject({ status: 'held', resource: 'rotterdam:truck:rtm-1700', priceEur: 210, caseId: 'case-1', heldBy: 'cargo:cargo-1', expiresAt: '2026-10-31T17:00:00.000Z' });
  });

  test('the haulier never withdraws because of its own key: replayed holds and confirms are one row and no withdrawal', () => {
    const { context, memory, offerId, key, ledger } = offered();
    const first = hear(context(), memory, [holdOf('case-1', offerId), settleOf('recovery.confirm', 'case-1', offerId)]);
    const again = hear(context(), first.memory, [holdOf('case-1', offerId, '2026-10-31T17:00:00.000Z', 'hold:again'), settleOf('recovery.confirm', 'case-1', offerId, 'confirm:again')]);
    expect([...first.posts, ...again.posts]).toEqual([]);
    expect(ledger.list('w1')).toHaveLength(1);
    expect(ledger.find(key)?.status).toBe('confirmed');
  });

  test('a release frees the truck for another case', () => {
    const { context, memory, offerId, key, ledger } = offered();
    const held = hear(context(), memory, [holdOf('case-1', offerId)]);
    hear(context(), held.memory, [settleOf('recovery.release', 'case-1', offerId)]);
    expect(ledger.find(key)?.status).toBe('released');
    expect(ledger.free(offerId, '2026-10-31T17:00:00.000Z', '2026-10-31T18:00:00.000Z')).toBe(true);
  });

  test('a confirm after the hold lapsed is answered with a withdrawal that says why', () => {
    const { context, memory, offerId, key, ledger, time } = offered();
    const held = hear(context(), memory, [holdOf('case-1', offerId, '2026-10-31T16:45:00.000Z')]);
    time.ms += 20 * 60_000;
    const late = hear(context(), held.memory, [settleOf('recovery.confirm', 'case-1', offerId)]);
    expect(late.posts).toMatchObject([{ kind: 'recovery.withdraw', offerId, reason: 'the hold expired before it was confirmed' }]);
    expect(ledger.find(key)?.status).toBe('expired');
  });

  test('a hold on a truck another case already holds is answered with a withdrawal', () => {
    const world = fresh();
    const one = hear(world.context(), emptyHaulierMemory, [request('case-1')]);
    const two = hear(world.context(), one.memory, [request('case-2')]);
    const id = offerFor('rtm-1700');
    const first = hear(world.context(), two.memory, [holdOf('case-1', id)]);
    const second = hear(world.context(), first.memory, [holdOf('case-2', id)]);
    expect(second.posts).toMatchObject([{ kind: 'recovery.withdraw', caseId: 'case-2', reason: 'the truck is already held for another case' }]);
    expect(world.ledger.find(bookingKey('case-2', id))).toBeUndefined();
  });

  test('a hold on an offer past its time is answered with a withdrawal', () => {
    const world = fresh();
    const answered = hear(world.context(), emptyHaulierMemory, [request('case-3')]);
    world.time.ms += 31 * 60_000;
    const stale = hear(world.context(), answered.memory, [holdOf('case-3', offerFor('rtm-1700'), '2026-10-31T20:00:00.000Z')]);
    expect(stale.posts).toMatchObject([{ kind: 'recovery.withdraw', caseId: 'case-3', reason: 'the offer had expired before it was held' }]);
    expect(world.ledger.find(bookingKey('case-3', offerFor('rtm-1700')))).toBeUndefined();
  });

  test('messages for offers the haulier never made change nothing', () => {
    const { context, ledger } = fresh();
    expect(hear(context(), emptyHaulierMemory, [holdOf('case-1', offerFor('rtm-1700'))]).posts).toEqual([]);
    expect(ledger.list('w1')).toEqual([]);
  });
});

describe('withdrawing a truck', () => {
  test('cancels what the ledger holds for it, posts the withdrawal citing the offer, frees the truck, and is a no-op once done', () => {
    const { context, ledger } = fresh();
    const first = hear(context(), emptyHaulierMemory, [request('case-1')]);
    const second = hear(context(), first.memory, [request('case-1', '2026-10-31T18:00:00.000Z')]);
    const offerId = offerFor('rtm-1930');
    const held = hear(context(), second.memory, [holdOf('case-1', offerId, '2026-10-31T17:00:00.000Z')]);
    const booking = ledger.find(bookingKey('case-1', offerId))!;
    expect(booking.status).toBe('held');
    const done = withdrawTruck(context(), held.memory, 'Simulated: withdrawn by the demo control.');
    expect(done.withdrawn).toBe(offerId);
    expect(done.posts).toMatchObject([{ kind: 'recovery.withdraw', offerId, caseId: 'case-1', answers: [second.posts[0]!.id], reason: 'Simulated: withdrawn by the demo control.' }]);
    expect(ledger.get(booking.id)?.status).toBe('released');
    expect(ledger.free(offerId, trucks[0]!.departs, '2026-10-31T21:00:00.000Z')).toBe(true);
    expect(done.memory.offers[bookingKey('case-1', offerId)]?.status).toBe('withdrawn');
    expect(done.memory.offers[bookingKey('case-1', offerFor('rtm-1700'))]?.status).toBe('open');
    expect(withdrawTruck(context(), done.memory, 'x', offerId)).toMatchObject({ posts: [], withdrawn: null });
  });

  test('withdraws the truck from every case it was offered to, each withdrawal citing its own offer', () => {
    const { context } = fresh();
    const one = hear(context(), emptyHaulierMemory, [request('case-1')]);
    const two = hear(context(), one.memory, [request('case-2')]);
    const done = withdrawTruck(context(), two.memory, 'driver unavailable', offerFor('rtm-1700'));
    expect(done.posts.map(post => post.caseId).sort()).toEqual(['case-1', 'case-2']);
    expect(done.posts.map(post => post.answers[0]).sort()).toEqual([one.posts[0]!.id, two.posts[0]!.id].sort());
  });

  test('with nothing offered there is nothing to withdraw', () => {
    const { context } = fresh();
    expect(withdrawTruck(context(), emptyHaulierMemory, 'x')).toMatchObject({ posts: [], withdrawn: null });
  });
});
