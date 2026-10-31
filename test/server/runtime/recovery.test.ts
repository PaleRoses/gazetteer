import { describe, expect, test } from 'bun:test';
import type { BoardMessage } from '../../../src/core/board';
import type { RecoveryMessage } from '../../../src/core/recovery';
import { act2Anchor } from '../../../src/core/services';
import { relaySuccess } from '../../../src/core/types';
import { createBookings } from '../../../src/server/booking/ledger';
import type { Inbox } from '../../../src/server/relay/inbox';
import { createRecovery, targetsOf, type Clients } from '../../../src/server/runtime/recovery';

const at = '2026-10-31T16:30:00.000Z';
const cargo = { role: 'cargo', id: 'cargo-1', vessel: 'Meridian Star' } as const;
const haulier = { role: 'haulier', city: 'rotterdam' } as const;
const desk = { role: 'city', city: 'rotterdam', element: 'terminal' } as const;
const base = { at, summary: 'x', caseId: 'case-1', answers: [] };
const request = (to: typeof haulier | typeof desk, service: 'truck' | 'unload'): RecoveryMessage => ({ ...base, id: `request:${service}`, kind: 'recovery.request', author: cargo, to, service });
const settle = (kind: 'recovery.hold' | 'recovery.confirm' | 'recovery.release', offerId: string): RecoveryMessage =>
  kind === 'recovery.hold' ? { ...base, id: `${kind}:${offerId}`, kind, author: cargo, offerId, key: `case-1:${offerId}`, expiresAt: at } : { ...base, id: `${kind}:${offerId}`, kind, author: cargo, offerId, key: `case-1:${offerId}` };
const truckOffer = 'rotterdam:truck:truck-1700';
const unloadOffer = 'rotterdam:unload:unload-1800';
const offerFrom = (author: typeof haulier | typeof desk, id: string): RecoveryMessage => author.role === 'haulier'
  ? { ...base, id: `offer:${id}`, kind: 'recovery.offer', author, offer: { service: 'truck', id, provider: author, departs: at, priceEur: 640, expiresAt: at } }
  : { ...base, id: `offer:${id}`, kind: 'recovery.offer', author, offer: { service: 'unload', id, provider: author, at, priceEur: 100, expiresAt: at } };

describe('who a recovery message is for', () => {
  test('a request goes to the provider it names, and nobody else', () => {
    expect(targetsOf(request(haulier, 'truck'))).toEqual([{ role: 'haulier', city: 'rotterdam' }]);
    expect(targetsOf(request(desk, 'unload'))).toEqual([{ role: 'terminal', city: 'rotterdam' }]);
  });

  test('an offer and a withdrawal go to the case\'s cargo agent', () => {
    expect(targetsOf(offerFrom(haulier, truckOffer))).toEqual([{ role: 'cargo' }]);
    expect(targetsOf({ ...base, id: 'w', kind: 'recovery.withdraw', author: haulier, offerId: truckOffer, reason: 'Simulated' })).toEqual([{ role: 'cargo' }]);
  });

  test('a hold, confirm or release goes to the provider whose offer it acts on', () => {
    (['recovery.hold', 'recovery.confirm', 'recovery.release'] as const).forEach(kind => {
      expect(targetsOf(settle(kind, truckOffer))).toEqual([{ role: 'haulier', city: 'rotterdam' }]);
      expect(targetsOf(settle(kind, unloadOffer))).toEqual([{ role: 'terminal', city: 'rotterdam' }]);
      expect(targetsOf(settle(kind, 'rotterdam:storage:plug-1:2026-10-31T18:00:00.000Z/2026-11-01T06:00:00.000Z'))).toEqual([{ role: 'terminal', city: 'rotterdam' }]);
    });
  });

  test('a plan, and any post that is not about recovery, go nowhere', () => {
    expect(targetsOf({ ...base, id: 'p', kind: 'recovery.plan', author: cargo, method: 'rule-based', outcome: { status: 'blocked', blocking: { kind: 'missing', service: 'truck' } } })).toEqual([]);
    expect(targetsOf({ id: 'o', kind: 'ship.observation', author: { role: 'ship', id: 'gz-1042', vessel: 'Meridian Star' }, at, summary: 'x' } as unknown as BoardMessage)).toEqual([]);
  });
});

/** Three fake actors with a durable outbox each, standing where the Terse stubs stand. */
function fakes() {
  const record = { initialized: [] as unknown[][], delivered: new Map<string, Inbox[]>(), resumed: [] as string[], withdrawn: [] as unknown[][], acknowledged: [] as string[][] };
  const outbox = new Map<string, BoardMessage[]>();
  const member = (name: string) => ({
    check: async () => relaySuccess(null),
    resume: async () => { record.resumed.push(name); },
    deliver: async (batch: Inbox) => { record.delivered.set(name, [...(record.delivered.get(name) ?? []), batch]); },
    unpublished: async () => ({ relay: { token: 't', channel: 'c' }, board: outbox.get(name) ?? [], disruptions: [] }),
    acknowledge: async (sent: Readonly<{ board: readonly string[] }>) => { record.acknowledged.push([...sent.board]); outbox.set(name, (outbox.get(name) ?? []).filter(message => !sent.board.includes(message.id))); },
  });
  const clients: Clients = {
    cargo: () => ({ ...member('cargo'), initialize: async (...args) => { record.initialized.push(['cargo', ...args]); return relaySuccess(null); }, snapshot: async () => ({ caseId: 'case:gz-1042:MSTU4182651', method: 'rule-based', plan: null, bookings: [], delivered: null }) }),
    terminal: () => ({ ...member('terminal'), initialize: async (...args) => { record.initialized.push(['terminal', ...args]); return relaySuccess(null); } }),
    haulier: () => ({ ...member('haulier'), initialize: async (...args) => { record.initialized.push(['haulier', ...args]); return relaySuccess(null); }, withdraw: async (...args) => { record.withdrawn.push(args); return relaySuccess(truckOffer); } }),
  };
  return { clients, record, outbox };
}

const ship = { id: 'gz-1042', vessel: 'Meridian Star', baselineEta: '2026-10-31T10:20:00.000Z' };
const until = async (condition: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !condition(); tries += 1) await Bun.sleep(5);
  expect(condition()).toBe(true);
};
const world = (options: Readonly<{ ship?: typeof ship | null }> = {}) => {
  const { clients, record, outbox } = fakes();
  const ledger = createBookings(':memory:');
  const sent: string[] = [];
  const absorbed: Inbox[] = [];
  const announced: string[] = [];
  const recovery = createRecovery({
    clients, workspaceKey: 'key', bookingsPath: '/data/bookings.sqlite', ledger, limit: operation => operation(),
    meridianStar: async () => options.ship === undefined ? ship : options.ship,
    send: async outgoing => { sent.push(...outgoing.board.map(message => message.id)); return { board: outgoing.board.map(message => message.id), disruptions: [], failure: null }; },
    absorb: async (_, batch) => { absorbed.push(batch); return batch.board.length; },
    announce: workspaceId => { announced.push(workspaceId); },
    delaysMs: [0], sleep: async () => undefined,
  });
  return { recovery, record, outbox, ledger, sent, absorbed, announced };
};

describe('act 2 at runtime', () => {
  test('before it begins there is nothing to show; then it starts the three actors from the ship\'s own anchor', async () => {
    const { recovery, record } = world();
    expect(recovery.view('w1')).toBeUndefined();
    recovery.begin('w1');
    await until(() => record.initialized.length === 3);
    const anchor = act2Anchor(ship);
    const byName = Object.fromEntries(record.initialized.map(call => [call[0] as string, call]));
    expect(byName.terminal).toEqual(['terminal', 'w1', 'rotterdam', 'key', false, '/data/bookings.sqlite', anchor]);
    expect(byName.haulier?.slice(0, 6)).toEqual(['haulier', 'w1', 'rotterdam', 'key', false, '/data/bookings.sqlite']);
    expect(byName.cargo?.slice(0, 5)).toEqual(['cargo', 'w1', 'key', '/data/bookings.sqlite', 'case:gz-1042:MSTU4182651']);
    expect(recovery.view('w1')).toEqual({ case: null, reservations: [] });
    recovery.close();
  });

  test('without the ship\'s actor the anchor is unknown, so nothing starts; it starts when the ship appears', async () => {
    const state: { current: typeof ship | null } = { current: null };
    const { clients, record } = fakes();
    const recovery = createRecovery({
      clients, workspaceKey: 'key', bookingsPath: '/x', ledger: createBookings(':memory:'), limit: operation => operation(),
      meridianStar: async () => state.current, send: async () => ({ board: [], disruptions: [], failure: null }), absorb: async () => 0, announce: () => undefined,
      delaysMs: [2],
    });
    recovery.begin('w1');
    await Bun.sleep(30);
    expect(record.initialized).toEqual([]);
    state.current = ship;
    await until(() => record.initialized.length === 3);
    recovery.close();
  });

  test('a message reaches only the actor it is for, cumulatively until that actor has taken it', async () => {
    const { recovery, record } = world();
    recovery.begin('w1');
    await until(() => record.initialized.length === 3);
    await recovery.deliver('w1', { board: [request(haulier, 'truck'), request(desk, 'unload'), offerFrom(haulier, truckOffer), settle('recovery.hold', truckOffer)], disruptions: [] });
    const ids = (name: string): string[] => (record.delivered.get(name) ?? []).flatMap(batch => batch.board.map(message => message.id));
    expect(ids('haulier').sort()).toEqual(['recovery.hold:rotterdam:truck:truck-1700', 'request:truck']);
    expect(ids('terminal')).toEqual(['request:unload']);
    expect(ids('cargo')).toEqual(['offer:rotterdam:truck:truck-1700']);
    recovery.close();
  });

  test('a step lets each ready actor speak: its posts are echoed to the others and written to Relay, and the case is reported', async () => {
    const { recovery, record, outbox, sent, absorbed, announced } = world();
    recovery.begin('w1');
    await until(() => record.initialized.length === 3);
    outbox.set('haulier', [offerFrom(haulier, truckOffer)]);
    expect(await recovery.step('w1')).toBe(1);
    expect(absorbed.flatMap(batch => batch.board.map(message => message.id))).toEqual(['offer:rotterdam:truck:truck-1700']);
    await until(() => sent.length === 1 && record.acknowledged.length === 1);
    expect(sent).toEqual(['offer:rotterdam:truck:truck-1700']);
    expect(record.acknowledged).toEqual([['offer:rotterdam:truck:truck-1700']]);
    await until(() => recovery.view('w1')?.case !== null);
    expect(recovery.view('w1')?.case).toEqual({ caseId: 'case:gz-1042:MSTU4182651', method: 'rule-based', plan: null, delivered: null });
    expect(announced).toContain('w1');
    recovery.close();
  });

  test('the reservations on the view are the ledger\'s, read without asking any actor', async () => {
    const { recovery, ledger, record } = world();
    recovery.begin('w1');
    await until(() => record.initialized.length === 3);
    const held = ledger.hold({ key: 'case-1:rotterdam:truck:truck-1700', workspaceId: 'w1', caseId: 'case-1', resource: truckOffer, start: at, end: '2026-10-31T17:30:00.000Z', priceEur: 640, expiresAt: '2099-01-01T00:00:00.000Z', heldBy: 'cargo:case-1' });
    expect(held.ok).toBe(true);
    expect(recovery.view('w1')?.reservations).toMatchObject([{ resource: truckOffer, status: 'held', caseId: 'case-1' }]);
    expect(recovery.view('w2')).toBeUndefined();
    recovery.close();
  });

  test('"Withdraw truck" asks the haulier for its last truck and says so; "Restart cargo agent" resumes the cargo agent', async () => {
    const { recovery, record } = world();
    expect(await recovery.withdrawTruck('w1')).toMatchObject({ status: 'unavailable' });
    expect(await recovery.restartCargo('w1')).toMatchObject({ status: 'unavailable' });
    recovery.begin('w1');
    await until(() => record.initialized.length === 3);
    await until(() => record.resumed.length === 3);
    expect(await recovery.withdrawTruck('w1')).toEqual(relaySuccess(truckOffer));
    expect(record.withdrawn).toEqual([['Simulated: the truck was withdrawn by the demo control.', null]]);
    record.resumed.length = 0;
    expect(await recovery.restartCargo('w1')).toEqual(relaySuccess(null));
    expect(record.resumed).toEqual(['cargo']);
    recovery.close();
  });
});
