import { describe, expect, test } from 'bun:test';
import { bookingKey, type Commitments, type Offer, type RecoveryMessage } from '../../../../src/core/recovery';
import type { TerminalRequest } from '../../../../src/core/services';
import { cycle } from '../../../../src/server/agents/cargo/cycle';
import { hear, negotiate, openCase, reconcile, type CaseState } from '../../../../src/server/agents/cargo/negotiate';
import { emptyTerminalMemory, hear as deskHears, type TerminalMemory } from '../../../../src/server/agents/city/terminal';
import { emptyHaulierMemory, hear as haulierHears, truckOfferId, withdrawTruck, type HaulierMemory } from '../../../../src/server/agents/haulier/decide';
import type { Truck } from '../../../../src/server/agents/haulier/truck';
import { createBookings, type Bookings } from '../../../../src/server/booking/ledger';

const now = '2026-10-31T14:00:00.000Z';
const later = '2026-10-31T23:00:00.000Z';
const unloadAt = '2026-10-31T18:00:00.000Z';
const terminal = { role: 'city', city: 'rotterdam', element: 'terminal' } as const;
const commitments: Commitments = {
  cargoId: 'cargo-reefer-1', shipmentId: 'meridian', vessel: 'Meridian Star', container: 'MSCU1234565', port: 'rotterdam',
  arrival: '2026-10-31T17:30:00.000Z', deliverBy: '2026-11-01T02:00:00.000Z', transitHours: 4, budgetEur: 1500, reefer: true,
  truckAppointment: '2026-10-31T17:00:00.000Z',
};
const trucks: readonly Truck[] = [
  { id: 't1700', departs: '2026-10-31T17:00:00.000Z', priceEur: 600 },
  { id: 't1930', departs: '2026-10-31T19:30:00.000Z', priceEur: 650 },
  { id: 't2100', departs: '2026-10-31T21:00:00.000Z', priceEur: 650 },
];
const truckId = (id: string) => truckOfferId('rotterdam', id);
const unloadId = 'rotterdam:unload:1800';
/** A storage offer on the one plug P1, named by its interval as the world names them, so the desk sees an extension on the plug the case already holds. */
const plugUntil = (until: string) => `rotterdam:storage:P1:${unloadAt}/${until}`;
const plug20 = plugUntil('2026-10-31T20:00:00.000Z');
const plug22 = plugUntil('2026-10-31T22:00:00.000Z');

/** The desk's prices and windows: an 18:00 unload, and powered storage on P1 from 18:00 to two hours, or to an hour past the asked end. */
const quote = (ask: TerminalRequest): Offer => ask.service === 'unload'
  ? { id: unloadId, service: 'unload', provider: terminal, at: unloadAt, priceEur: 400, expiresAt: later }
  : (until => ({ id: plugUntil(until), service: 'storage', provider: terminal, powered: true, from: unloadAt, until, priceEur: 150, expiresAt: later }) as const)(
    ask.until ? new Date(Date.parse(ask.until) + 3_600_000).toISOString() : '2026-10-31T20:00:00.000Z');

type World = Readonly<{ cargo: CaseState; haulier: HaulierMemory; desk: TerminalMemory; board: readonly RecoveryMessage[] }>;

/** Act 2 in memory: the cargo agent reads the ledger and posts, the real haulier and the real terminal desk hear the board and write the ledger. */
const world = () => {
  const ledger = createBookings(':memory:', () => Date.parse(now));
  const haulierContext = { city: 'rotterdam' as const, workspaceId: 'w1', trucks, now, ledger };
  const deskContext = { city: 'rotterdam' as const, workspaceId: 'w1', now, ledger, quote };
  const round = ({ cargo, haulier, desk, board }: World): World => {
    const done = cycle(reconcile(hear(cargo, board), key => ledger.find(key)?.status), now);
    const afterCargo = [...board, ...done.messages];
    const hauled = haulierHears(haulierContext, haulier, afterCargo);
    const desked = deskHears(deskContext, desk, afterCargo);
    return { cargo: done.state, haulier: hauled.memory, desk: desked.memory, board: [...afterCargo, ...hauled.posts, ...desked.posts] };
  };
  /** Rounds until one adds nothing to the board: no one heard anything new, so no one wrote the ledger either. */
  const settle = (start: World, rounds = 30): World => {
    const next = round(start);
    return rounds <= 1 || next.board.length === start.board.length ? next : settle(next, rounds - 1);
  };
  const until = (start: World, done: (world: World) => boolean, rounds = 30): World => done(start) || rounds <= 0 ? start : until(round(start), done, rounds - 1);
  const withdraw = (at: World, offerId: string): World => {
    const withdrawn = withdrawTruck(haulierContext, at.haulier, 'driver unavailable', offerId);
    return { ...at, haulier: withdrawn.memory, board: [...at.board, ...withdrawn.posts] };
  };
  const start: World = { cargo: openCase('case-1', { id: 'cargo-reefer-1', vessel: 'Meridian Star' }, commitments), haulier: emptyHaulierMemory, desk: emptyTerminalMemory, board: [] };
  return { ledger, settle, until, withdraw, start };
};
const statusOf = (ledger: Bookings, offerId: string) => ledger.find(bookingKey('case-1', offerId))?.status;
const kindsFor = (board: readonly RecoveryMessage[], offerId: string) => board.flatMap(message => 'offerId' in message && message.offerId === offerId ? [message.kind] : []);

describe('the cargo agent negotiates its recovery with the real haulier and terminal desk, which write the ledger', () => {
  test('blocked by the 17:00 truck, it asks for a later one, then holds and confirms a plan that fits, and books each thing once', () => {
    const { ledger, settle, start } = world();
    const done = settle(start);
    const blocked = done.board.find(message => message.kind === 'recovery.plan' && message.outcome.status === 'blocked');
    expect(blocked).toMatchObject({ method: 'rule-based', outcome: { blocking: { kind: 'truck-before-unload', truck: truckId('t1700'), unload: unloadId } } });
    expect(blocked?.summary).toContain('The truck leaves at 17:00Z, before the container is unloaded at 18:00Z.');
    expect(done.board.some(message => message.kind === 'recovery.request' && message.to.role === 'haulier' && message.after === unloadAt && message.answers.includes(blocked!.id))).toBe(true);
    expect(done.cargo.plan).toMatchObject({ unload: unloadId, storage: plug20, truck: truckId('t1930'), delivered: '2026-10-31T23:30:00.000Z' });
    expect([statusOf(ledger, unloadId), statusOf(ledger, plug20), statusOf(ledger, truckId('t1930'))]).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(statusOf(ledger, truckId('t1700'))).toBeUndefined();
    expect(kindsFor(done.board, unloadId)).toEqual(['recovery.hold', 'recovery.confirm']);
    expect(ledger.find(bookingKey('case-1', truckId('t1930')))).toMatchObject({ resource: truckId('t1930'), heldBy: 'cargo:cargo-reefer-1' });
    expect([ledger.find(bookingKey('case-1', unloadId))?.resource, ledger.find(bookingKey('case-1', plug20))?.resource]).toEqual([unloadId, 'rotterdam:plug:P1']);
    const keys = ledger.list('w1').map(booking => booking.id);
    expect(new Set(keys).size).toBe(keys.length);
    expect(settle(done).board.length).toBe(done.board.length);
    expect(negotiate(done.cargo, now)).toMatchObject({ messages: [], actions: [] });
  });

  test('when the haulier withdraws the 19:30 truck, the case recovers on the next truck and an extended plug, and the confirmed unload is never touched', () => {
    const { ledger, settle, withdraw, start } = world();
    const confirmed = settle(start);
    const unloadRow = ledger.find(bookingKey('case-1', unloadId));
    const recovered = settle(withdraw(confirmed, truckId('t1930')));
    expect(recovered.cargo.plan).toMatchObject({ unload: unloadId, truck: truckId('t2100'), storage: plug22 });
    expect([statusOf(ledger, truckId('t1930')), statusOf(ledger, plug20)]).toEqual(['released', 'released']);
    expect([statusOf(ledger, truckId('t2100')), statusOf(ledger, plug22)]).toEqual(['confirmed', 'confirmed']);
    expect(ledger.find(bookingKey('case-1', unloadId))).toEqual(unloadRow);
    expect(kindsFor(recovered.board, unloadId)).toEqual(['recovery.hold', 'recovery.confirm']);
  });

  test('a truck taken by another case after it was offered is withdrawn by the haulier at the hold, and the case moves to the next truck', () => {
    const { ledger, settle, until, start } = world();
    const offered = until(start, at => at.board.some(message => message.kind === 'recovery.offer' && message.offer.id === truckId('t1930')));
    const taken = ledger.hold({ key: 'other-case:t1930', workspaceId: 'w1', caseId: 'other-case', resource: truckId('t1930'), start: '2026-10-31T19:30:00.000Z', end: '2026-10-31T20:30:00.000Z', priceEur: 650, expiresAt: later, heldBy: 'someone' });
    expect(taken.ok).toBe(true);
    const moved = settle(offered);
    expect(moved.board.some(message => message.kind === 'recovery.withdraw' && message.offerId === truckId('t1930'))).toBe(true);
    expect(moved.cargo.withdrawn).toContain(truckId('t1930'));
    expect(statusOf(ledger, truckId('t1930'))).toBeUndefined();
    expect(moved.cargo.plan).toMatchObject({ unload: unloadId, truck: truckId('t2100'), storage: plug22 });
    expect([statusOf(ledger, unloadId), statusOf(ledger, plug22), statusOf(ledger, truckId('t2100'))]).toEqual(['confirmed', 'confirmed', 'confirmed']);
  });

  test('the old storage is not released while its replacement cannot be had', () => {
    const { ledger, settle, withdraw, start } = world();
    const confirmed = settle(start);
    const taken = ledger.hold({ key: 'other-case:plug', workspaceId: 'w1', caseId: 'other-case', resource: 'rotterdam:plug:P1', start: '2026-10-31T20:00:00.000Z', end: '2026-10-31T22:00:00.000Z', priceEur: 150, expiresAt: later, heldBy: 'someone' });
    expect(taken.ok).toBe(true);
    const stuck = settle(withdraw(confirmed, truckId('t1930')));
    expect(stuck.cargo.plan).toBeNull();
    expect([statusOf(ledger, unloadId), statusOf(ledger, plug20)]).toEqual(['confirmed', 'confirmed']);
  });

  test('a restart from the persisted case mid-negotiation re-decides the same keys and the ledger books nothing twice', () => {
    const { ledger, settle, until, start } = world();
    const holding = until(start, at => at.board.some(message => message.kind === 'recovery.hold'));
    const persisted = holding.cargo;
    const once = settle(holding);
    const rows = ledger.list('w1');
    const restarted = settle({ ...once, cargo: persisted });
    expect(ledger.list('w1')).toEqual(rows);
    expect(restarted.cargo.plan?.offerIds).toEqual(once.cargo.plan?.offerIds);
    expect(restarted.cargo.bookings.filter(item => item.status === 'confirmed').map(item => item.offerId).toSorted()).toEqual([...once.cargo.plan!.offerIds].toSorted());
  });
});

describe('the negotiator alone', () => {
  const opened = openCase('case-1', { id: 'cargo-reefer-1', vessel: 'Meridian Star' }, commitments);
  const offer = (o: Offer): RecoveryMessage => ({ id: `m-${o.id}`, kind: 'recovery.offer', at: now, caseId: 'case-1', author: o.provider, offer: o, answers: [], summary: o.id });
  const unload: Offer = { id: 'u', service: 'unload', provider: terminal, at: unloadAt, priceEur: 400, expiresAt: later };
  const storage: Offer = { id: 'p', service: 'storage', provider: terminal, powered: true, from: unloadAt, until: '2026-10-31T20:00:00.000Z', priceEur: 150, expiresAt: later };
  const truck: Offer = { id: 'k', service: 'truck', provider: { role: 'haulier', city: 'rotterdam' }, departs: '2026-10-31T19:30:00.000Z', priceEur: 650, expiresAt: later };
  const ready = hear(negotiate(opened, now).state, [offer(unload), offer(storage), offer(truck)]);

  test('asks the terminal for unload and powered storage and the haulier for its original truck, then waits quietly for answers', () => {
    const first = negotiate(opened, now);
    expect(first.messages.map(message => message.kind === 'recovery.request' ? [message.to.role, message.service, message.after] : [])).toEqual([
      ['city', 'unload', commitments.arrival], ['city', 'storage', commitments.arrival], ['haulier', 'truck', commitments.truckAppointment],
    ]);
    expect(negotiate(first.state, now)).toMatchObject({ messages: [], actions: [] });
  });

  test('a hold is only requested: no confirm in the check that posts it, none until the ledger shows every hold of the plan, and each confirm once', () => {
    const holding = cycle(ready, now);
    expect(holding.messages.flatMap(message => message.kind === 'recovery.hold' ? [message.offerId] : []).toSorted()).toEqual(['k', 'p', 'u']);
    expect(holding.messages.some(message => message.kind === 'recovery.confirm')).toBe(false);
    expect(holding.state.bookings.map(item => item.status)).toEqual(['requested', 'requested', 'requested']);
    const partly = reconcile(holding.state, key => key === bookingKey('case-1', 'k') ? undefined : 'held');
    expect(cycle(partly, now).messages.some(message => message.kind === 'recovery.confirm')).toBe(false);
    const held = cycle(reconcile(holding.state, () => 'held'), now);
    expect(held.messages.flatMap(message => message.kind === 'recovery.confirm' ? [message.offerId] : []).toSorted()).toEqual(['k', 'p', 'u']);
    expect(negotiate(held.state, now)).toMatchObject({ messages: [], actions: [] });
  });

  test('a withdrawn hold drops its offer from the case, and an expired hold is never confirmed', () => {
    const holding = cycle(ready, now);
    const refused: RecoveryMessage = { id: 'w-k', kind: 'recovery.withdraw', at: now, caseId: 'case-1', author: truck.provider, offerId: 'k', reason: 'taken', answers: ['m-k'], summary: 'k is taken' };
    const dropped = cycle(hear(holding.state, [refused]), now);
    expect(dropped.state.plan).toBeNull();
    expect(dropped.messages.some(message => message.kind === 'recovery.confirm')).toBe(false);
    const expired = reconcile(holding.state, () => 'expired');
    expect(expired.bookings.every(item => item.status === 'released')).toBe(true);
    expect(negotiate(expired, now).actions.some(action => action.kind === 'confirm')).toBe(false);
  });
});
