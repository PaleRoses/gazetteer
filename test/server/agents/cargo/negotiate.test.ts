import { describe, expect, test } from 'bun:test';
import type { Commitments, Offer, RecoveryMessage } from '../../../../src/core/recovery';
import { hear, negotiate, openCase, settle, type CaseState, type Decision } from '../../../../src/server/agents/cargo/negotiate';

const now = '2026-10-31T14:00:00.000Z';
const later = '2026-10-31T23:00:00.000Z';
const terminal = { role: 'city', city: 'rotterdam', element: 'terminal' } as const;
const haulier = { role: 'haulier', city: 'rotterdam' } as const;
const commitments: Commitments = {
  cargoId: 'cargo-reefer-1', shipmentId: 'meridian', vessel: 'Meridian Star', container: 'MSCU1234565', port: 'rotterdam',
  arrival: '2026-10-31T17:30:00.000Z', deliverBy: '2026-11-01T02:00:00.000Z', transitHours: 4, budgetEur: 1500, reefer: true,
  truckAppointment: '2026-10-31T13:00:00.000Z',
};
const unload: Offer = { id: 'unload-18', service: 'unload', provider: terminal, at: '2026-10-31T18:00:00.000Z', priceEur: 400, expiresAt: later };
const plug: Offer = { id: 'reefer-18-20', service: 'storage', provider: terminal, powered: true, from: '2026-10-31T18:00:00.000Z', until: '2026-10-31T20:00:00.000Z', priceEur: 150, expiresAt: later };
const longPlug: Offer = { ...plug, id: 'reefer-18-22', until: '2026-10-31T22:00:00.000Z', priceEur: 250 };
const truck17: Offer = { id: 'truck-17', service: 'truck', provider: haulier, departs: '2026-10-31T17:00:00.000Z', priceEur: 600, expiresAt: later };
const truck1930: Offer = { ...truck17, id: 'truck-1930', departs: '2026-10-31T19:30:00.000Z', priceEur: 650 };
const truck21: Offer = { ...truck17, id: 'truck-21', departs: '2026-10-31T21:00:00.000Z', priceEur: 650 };
const offered = (offer: Offer): RecoveryMessage =>
  ({ id: `msg-${offer.id}`, kind: 'recovery.offer', at: now, caseId: 'case-1', author: offer.provider, offer, answers: [], summary: `Offer ${offer.id}` });
const withdrawn = (offerId: string): RecoveryMessage =>
  ({ id: `msg-withdraw-${offerId}`, kind: 'recovery.withdraw', at: now, caseId: 'case-1', author: haulier, offerId, reason: 'driver unavailable', answers: [`msg-${offerId}`], summary: `Withdrawn ${offerId}` });

/** Runs the negotiator to quiet against an ideal ledger, the way the actor's cycle does. */
const runToQuiet = (start: CaseState): Readonly<{ state: CaseState; messages: readonly RecoveryMessage[]; keys: readonly string[] }> => {
  const loop = (state: CaseState, messages: readonly RecoveryMessage[], keys: readonly string[], left: number): ReturnType<typeof runToQuiet> => {
    const decided: Decision = negotiate(state, now);
    const settled = settle(decided.state, decided.actions.map(action => ({ action, ok: true })), now);
    const all = [...messages, ...decided.messages, ...settled.messages];
    const nextKeys = [...keys, ...decided.actions.map(action => `${action.kind}:${action.key}`)];
    return decided.actions.length === 0 && decided.messages.length === 0 || left === 0 ? { state: settled.state, messages: all, keys: nextKeys } : loop(settled.state, all, nextKeys, left - 1);
  };
  return loop(start, [], [], 10);
};
const kinds = (messages: readonly RecoveryMessage[]) => messages.map(message => message.kind);

describe('the deterministic cargo negotiator', () => {
  const opened = openCase('case-1', { id: 'cargo-reefer-1', vessel: 'Meridian Star' }, commitments);

  test('asks the terminal for unload and powered storage and the haulier for a truck, once', () => {
    const first = negotiate(opened, now);
    expect(first.messages.map(message => message.kind === 'recovery.request' ? [message.to.role, message.service] : [])).toEqual([['city', 'unload'], ['city', 'storage'], ['haulier', 'truck']]);
    expect(negotiate(first.state, now).messages.every(message => message.kind !== 'recovery.request' || !first.messages.some(sent => sent.id === message.id))).toBe(true);
  });

  test('the story: blocked by the 17:00 truck, a later truck asked for, then held, confirmed, nothing booked twice', () => {
    const asked = negotiate(opened, now).state;
    const blocked = negotiate(hear(asked, [offered(unload), offered(plug), offered(truck17)]), now);
    const plan = blocked.messages.find(message => message.kind === 'recovery.plan');
    expect(plan).toMatchObject({ method: 'rule-based', outcome: { status: 'blocked', blocking: { kind: 'truck-before-unload', truck: 'truck-17', unload: 'unload-18' } }, answers: ['msg-truck-17', 'msg-unload-18'] });
    expect(blocked.messages.find(message => message.kind === 'recovery.request')).toMatchObject({ to: haulier, service: 'truck', after: unload.at, answers: [plan!.id, 'msg-truck-17', 'msg-unload-18'] });
    expect(blocked.actions).toEqual([]);

    const fitted = runToQuiet(hear(blocked.state, [offered(truck1930)]));
    expect(kinds(fitted.messages)).toEqual(['recovery.plan', 'recovery.hold', 'recovery.hold', 'recovery.hold', 'recovery.confirm', 'recovery.confirm', 'recovery.confirm']);
    expect(fitted.state.bookings.map(item => [item.offerId, item.status])).toEqual([['unload-18', 'confirmed'], ['reefer-18-20', 'confirmed'], ['truck-1930', 'confirmed']]);
    expect(fitted.state.plan?.delivered).toBe('2026-10-31T23:30:00.000Z');
    expect(new Set(fitted.keys).size).toBe(fitted.keys.length);

    const replay = negotiate(fitted.state, now);
    expect(replay).toMatchObject({ messages: [], actions: [] });
  });

  test('a withdrawn truck is recovered with the next truck and longer storage, and the confirmed unload is never released', () => {
    const asked = negotiate(opened, now).state;
    const confirmed = runToQuiet(hear(asked, [offered(unload), offered(plug), offered(truck17), offered(truck1930)])).state;
    const lost = negotiate(hear(confirmed, [withdrawn('truck-1930')]), now);
    expect(lost.actions).toEqual([{ kind: 'release', key: 'case-1:truck-1930', offerId: 'truck-1930' }]);
    expect(lost.messages.find(message => message.kind === 'recovery.request')).toMatchObject({ to: haulier, service: 'truck' });
    const afterLoss = settle(lost.state, lost.actions.map(action => ({ action, ok: true })), now).state;

    const recovered = runToQuiet(hear(afterLoss, [offered(truck21), offered(longPlug)]));
    const statuses = Object.fromEntries(recovered.state.bookings.map(item => [item.offerId, item.status]));
    expect(statuses).toEqual({ 'unload-18': 'confirmed', 'truck-1930': 'released', 'reefer-18-22': 'confirmed', 'truck-21': 'confirmed', 'reefer-18-20': 'released' });
    expect(recovered.keys.some(key => key === 'release:case-1:unload-18' || key === 'hold:case-1:unload-18')).toBe(false);
    expect(recovered.state.plan).toMatchObject({ unload: 'unload-18', storage: 'reefer-18-22', truck: 'truck-21' });
  });

  test('a restart before the ledger answered re-decides the same keys, so an idempotent ledger books once', () => {
    const asked = negotiate(opened, now).state;
    const ready = hear(asked, [offered(unload), offered(plug), offered(truck1930)]);
    const before = negotiate(ready, now);
    const afterRestart = negotiate(ready, now);
    expect(afterRestart.actions.map(action => action.key)).toEqual(before.actions.map(action => action.key));
    expect(before.actions.map(action => action.key)).toEqual(['case-1:unload-18', 'case-1:reefer-18-20', 'case-1:truck-1930']);
  });

  test('a failed hold is not recorded, and the next cycle asks the ledger again with the same key', () => {
    const asked = negotiate(opened, now).state;
    const ready = negotiate(hear(asked, [offered(unload), offered(plug), offered(truck1930)]), now);
    const failed = settle(ready.state, ready.actions.map(action => ({ action, ok: action.offerId !== 'truck-1930' })), now);
    expect(failed.state.bookings.map(item => item.offerId)).toEqual(['unload-18', 'reefer-18-20']);
    expect(negotiate(failed.state, now).actions).toEqual([expect.objectContaining({ kind: 'hold', key: 'case-1:truck-1930' })]);
  });
});
