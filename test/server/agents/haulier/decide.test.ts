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
  const ledger = createBookings(':memory:', () => Date.parse(now));
  const context = (overrides: Partial<HaulierContext> = {}): HaulierContext => ({ city: 'rotterdam', trucks, now, ledger, ...overrides });
  return { ledger, context };
};
/** What the cargo agent's ledger step does with an offer it accepts: books the truck's id as the resource over the haul. */
const book = (ledger: ReturnType<typeof fresh>['ledger'], caseId: string, truck: Truck, hours = 3) => {
  const offerId = offerFor(truck.id);
  const held = ledger.hold({ key: bookingKey(caseId, offerId), workspaceId: 'w1', caseId, resource: offerId, start: truck.departs, end: new Date(Date.parse(truck.departs) + hours * 3_600_000).toISOString(), priceEur: truck.priceEur, expiresAt: '2026-10-31T17:00:00.000Z', heldBy: 'cargo' });
  if (!held.ok) throw new Error(held.error);
  return held.value;
};
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
    const { context, ledger } = fresh();
    book(ledger, 'case-9', trucks[1]!);
    expect(offers(hear(context(), emptyHaulierMemory, [request('case-1')]).posts)[0]?.id).toBe(offerFor('rtm-1930'));
  });

  test('says nothing when it has no truck to give', () => {
    const { context } = fresh();
    expect(hear(context({ trucks: [] }), emptyHaulierMemory, [request('case-1')]).posts).toEqual([]);
  });
});

describe('withdrawing a truck', () => {
  test('cancels what the ledger holds for it, posts the withdrawal citing the offer, frees the truck, and is a no-op once done', () => {
    const { context, ledger } = fresh();
    const first = hear(context(), emptyHaulierMemory, [request('case-1')]);
    const second = hear(context(), first.memory, [request('case-1', '2026-10-31T18:00:00.000Z')]);
    const offerId = offerFor('rtm-1930');
    const booking = book(ledger, 'case-1', trucks[0]!);
    const done = withdrawTruck(context(), second.memory, 'Simulated: withdrawn by the demo control.');
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
