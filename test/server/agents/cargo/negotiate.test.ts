import { describe, expect, test } from 'bun:test';
import { bookingKey, type Commitments, type Offer, type RecoveryMessage } from '../../../../src/core/recovery';
import { cycle, executeOn } from '../../../../src/server/agents/cargo/cycle';
import { hear, negotiate, openCase, reconcile, type CaseState } from '../../../../src/server/agents/cargo/negotiate';
import { emptyHaulierMemory, hear as haulierHears, truckOfferId, withdrawTruck, type HaulierMemory } from '../../../../src/server/agents/haulier/decide';
import type { Truck } from '../../../../src/server/agents/haulier/truck';
import { createBookings } from '../../../../src/server/booking/ledger';

const now = '2026-10-31T14:00:00.000Z';
const later = '2026-10-31T23:00:00.000Z';
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

/** A fixture terminal desk: an 18:00 unload and a two-hour reefer plug, and a longer plug when asked to cover a later truck. */
const terminalAnswers = (heard: readonly RecoveryMessage[], answered: ReadonlySet<string>): readonly RecoveryMessage[] =>
  heard.flatMap((message): RecoveryMessage[] => {
    if (message.kind !== 'recovery.request' || message.to.role !== 'city' || answered.has(message.id)) return [];
    const until = message.until ? new Date(Date.parse(message.until) + 3_600_000).toISOString() : '2026-10-31T20:00:00.000Z';
    const offer: Offer = message.service === 'unload'
      ? { id: 'rotterdam:unload:1800', service: 'unload', provider: terminal, at: '2026-10-31T18:00:00.000Z', priceEur: 400, expiresAt: later }
      : { id: `rotterdam:plug:1800-${until.slice(11, 13)}`, service: 'storage', provider: terminal, powered: true, from: '2026-10-31T18:00:00.000Z', until, priceEur: 150, expiresAt: later };
    return [{ id: `terminal:${message.id}`, kind: 'recovery.offer', at: now, caseId: message.caseId, author: terminal, offer, answers: [message.id], summary: `Offer ${offer.id}` }];
  });

/** The board of act 2 in memory: the cargo agent, the real haulier decisions and a fixture terminal, all on one real sandbox ledger. */
const world = () => {
  const ledger = createBookings(':memory:', () => Date.parse(now));
  const run = executeOn(ledger, 'w1', 'cargo-reefer-1');
  type World = Readonly<{ cargo: CaseState; haulier: HaulierMemory; board: readonly RecoveryMessage[] }>;
  const round = ({ cargo, haulier, board }: World): World => {
    const done = cycle(reconcile(hear(cargo, board), key => ledger.find(key)?.status), now, run);
    const afterCargo = [...board, ...done.messages];
    const hauled = haulierHears({ city: 'rotterdam', trucks, now, ledger }, haulier, afterCargo);
    const answered = new Set(afterCargo.flatMap(message => message.kind === 'recovery.offer' ? message.answers : []));
    return { cargo: done.state, haulier: hauled.memory, board: [...afterCargo, ...hauled.posts, ...terminalAnswers(afterCargo, answered)] };
  };
  const settle = (start: World, rounds = 6): World => {
    const next = round(start);
    return rounds <= 1 || next.board.length === start.board.length ? next : settle(next, rounds - 1);
  };
  const start: World = { cargo: openCase('case-1', { id: 'cargo-reefer-1', vessel: 'Meridian Star' }, commitments), haulier: emptyHaulierMemory, board: [] };
  return { ledger, settle, start };
};
const statusOf = (ledger: ReturnType<typeof createBookings>, offerId: string) => ledger.find(bookingKey('case-1', offerId))?.status;

describe('the cargo agent negotiates its recovery with the real haulier on the real ledger', () => {
  test('blocked by the 17:00 truck, it asks for a later one, then holds and confirms a plan that fits, and books each thing once', () => {
    const { ledger, settle, start } = world();
    const done = settle(start);
    const blocked = done.board.find(message => message.kind === 'recovery.plan' && message.outcome.status === 'blocked');
    expect(blocked).toMatchObject({ method: 'rule-based', outcome: { blocking: { kind: 'truck-before-unload', truck: truckId('t1700'), unload: 'rotterdam:unload:1800' } } });
    expect(blocked?.summary).toContain('The truck leaves at 17:00Z, before the container is unloaded at 18:00Z.');
    expect(done.board.some(message => message.kind === 'recovery.request' && message.to.role === 'haulier' && message.after === '2026-10-31T18:00:00.000Z' && message.answers.includes(blocked!.id))).toBe(true);
    expect(done.cargo.plan).toMatchObject({ unload: 'rotterdam:unload:1800', storage: 'rotterdam:plug:1800-20', truck: truckId('t1930'), delivered: '2026-10-31T23:30:00.000Z' });
    expect([statusOf(ledger, 'rotterdam:unload:1800'), statusOf(ledger, 'rotterdam:plug:1800-20'), statusOf(ledger, truckId('t1930'))]).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect(statusOf(ledger, truckId('t1700'))).toBeUndefined();
    const keys = ledger.list('w1').map(booking => booking.id);
    expect(new Set(keys).size).toBe(keys.length);
    expect(settle(done).board.length).toBe(done.board.length);
    expect(negotiate(done.cargo, now)).toMatchObject({ messages: [], actions: [] });
  });

  test('when the haulier withdraws the 19:30 truck, the case recovers on the next truck and longer storage, and the confirmed unload is never touched', () => {
    const { ledger, settle, start } = world();
    const confirmed = settle(start);
    const unloadRow = ledger.find(bookingKey('case-1', 'rotterdam:unload:1800'));
    const withdrawn = withdrawTruck({ city: 'rotterdam', trucks, now, ledger }, confirmed.haulier, 'driver unavailable', truckId('t1930'));
    const recovered = settle({ ...confirmed, haulier: withdrawn.memory, board: [...confirmed.board, ...withdrawn.posts] });
    expect(recovered.cargo.plan).toMatchObject({ unload: 'rotterdam:unload:1800', truck: truckId('t2100'), storage: 'rotterdam:plug:1800-22' });
    expect([statusOf(ledger, truckId('t1930')), statusOf(ledger, 'rotterdam:plug:1800-20')]).toEqual(['released', 'released']);
    expect([statusOf(ledger, truckId('t2100')), statusOf(ledger, 'rotterdam:plug:1800-22')]).toEqual(['confirmed', 'confirmed']);
    expect(ledger.find(bookingKey('case-1', 'rotterdam:unload:1800'))).toEqual(unloadRow);
  });

  test('the old storage is not released while its replacement cannot be held', () => {
    const { ledger, settle, start } = world();
    const confirmed = settle(start);
    const taken = ledger.hold({ key: 'other-case:plug', workspaceId: 'w1', caseId: 'other-case', resource: 'rotterdam:plug:1800-22', start: '2026-10-31T18:00:00.000Z', end: '2026-10-31T22:00:00.000Z', priceEur: 150, expiresAt: later, heldBy: 'someone' });
    expect(taken.ok).toBe(true);
    const withdrawn = withdrawTruck({ city: 'rotterdam', trucks, now, ledger }, confirmed.haulier, 'driver unavailable', truckId('t1930'));
    const stuck = settle({ ...confirmed, haulier: withdrawn.memory, board: [...confirmed.board, ...withdrawn.posts] });
    expect(stuck.cargo.plan).toBeNull();
    expect([statusOf(ledger, 'rotterdam:unload:1800'), statusOf(ledger, 'rotterdam:plug:1800-20')]).toEqual(['confirmed', 'confirmed']);
  });

  test('a restart from the persisted case mid-negotiation re-decides the same keys and the ledger books nothing twice', () => {
    const { ledger, settle, start } = world();
    const offered = settle(start, 2);
    const persisted = offered.cargo;
    const once = settle(offered);
    const rows = ledger.list('w1').length;
    const restarted = settle({ ...once, cargo: persisted });
    expect(ledger.list('w1').length).toBe(rows);
    expect(restarted.cargo.plan?.offerIds).toEqual(once.cargo.plan?.offerIds);
  });
});

describe('the negotiator alone', () => {
  const opened = openCase('case-1', { id: 'cargo-reefer-1', vessel: 'Meridian Star' }, commitments);
  test('asks the terminal for unload and powered storage and the haulier for its original truck, then waits quietly for answers', () => {
    const first = negotiate(opened, now);
    expect(first.messages.map(message => message.kind === 'recovery.request' ? [message.to.role, message.service, message.after] : [])).toEqual([
      ['city', 'unload', commitments.arrival], ['city', 'storage', commitments.arrival], ['haulier', 'truck', commitments.truckAppointment],
    ]);
    expect(negotiate(first.state, now)).toMatchObject({ messages: [], actions: [] });
  });
  test('nothing is confirmed until every hold of the plan is in the ledger, and an expired hold is never confirmed', () => {
    const ledger = createBookings(':memory:', () => Date.parse(now));
    const offer = (o: Offer): RecoveryMessage => ({ id: `m-${o.id}`, kind: 'recovery.offer', at: now, caseId: 'case-1', author: o.provider, offer: o, answers: [], summary: o.id });
    const unload: Offer = { id: 'u', service: 'unload', provider: terminal, at: '2026-10-31T18:00:00.000Z', priceEur: 400, expiresAt: later };
    const plug: Offer = { id: 'p', service: 'storage', provider: terminal, powered: true, from: '2026-10-31T18:00:00.000Z', until: '2026-10-31T20:00:00.000Z', priceEur: 150, expiresAt: later };
    const truck: Offer = { id: 'k', service: 'truck', provider: { role: 'haulier', city: 'rotterdam' }, departs: '2026-10-31T19:30:00.000Z', priceEur: 650, expiresAt: later };
    const ready = hear(negotiate(opened, now).state, [offer(unload), offer(plug), offer(truck)]);
    const holds = negotiate(ready, now);
    expect(holds.actions.map(action => action.kind)).toEqual(['hold', 'hold', 'hold']);
    const taken = ledger.hold({ key: 'other-case:k', workspaceId: 'w1', caseId: 'other-case', resource: 'k', start: truck.departs, end: '2026-10-31T23:30:00.000Z', priceEur: 650, expiresAt: later, heldBy: 'someone' });
    expect(taken.ok).toBe(true);
    const done = cycle(ready, now, executeOn(ledger, 'w1', 'cargo-reefer-1'));
    expect(done.messages.some(message => message.kind === 'recovery.confirm')).toBe(false);
    expect(done.state.withdrawn).toContain('k');
    const expired = reconcile(done.state, () => 'expired');
    expect(expired.bookings.every(item => item.status === 'released')).toBe(true);
    expect(negotiate(expired, now).actions.some(action => action.kind === 'confirm')).toBe(false);
  });
});
