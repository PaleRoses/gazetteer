import { describe, expect, test } from 'bun:test';
import { bookingKey, describeConstraint, fit, recoveryMessage, remedyFor, type Commitments, type Offer } from '../../src/core/recovery';

const now = '2026-10-31T14:00:00.000Z';
const later = '2026-10-31T23:00:00.000Z';
const terminal = { role: 'city', city: 'rotterdam', element: 'terminal' } as const;
const haulier = { role: 'haulier', city: 'rotterdam' } as const;
const reefer: Commitments = {
  cargoId: 'cargo-msc-reefer-1', shipmentId: 'meridian', vessel: 'Meridian Star', container: 'MSCU1234565', port: 'rotterdam',
  arrival: '2026-10-31T17:30:00.000Z', deliverBy: '2026-11-01T02:00:00.000Z', transitHours: 4, budgetEur: 1500, reefer: true,
  truckAppointment: '2026-10-31T13:00:00.000Z',
};
const unload: Offer = { id: 'unload-18', service: 'unload', provider: terminal, at: '2026-10-31T18:00:00.000Z', priceEur: 400, expiresAt: later };
const plug: Offer = { id: 'reefer-18-20', service: 'storage', provider: terminal, powered: true, from: '2026-10-31T18:00:00.000Z', until: '2026-10-31T20:00:00.000Z', priceEur: 150, expiresAt: later };
const truck17: Offer = { id: 'truck-17', service: 'truck', provider: haulier, departs: '2026-10-31T17:00:00.000Z', priceEur: 600, expiresAt: later };
const truck1930: Offer = { id: 'truck-1930', service: 'truck', provider: haulier, departs: '2026-10-31T19:30:00.000Z', priceEur: 650, expiresAt: later };

describe('fit: the recovery solver', () => {
  test('a 17:00 truck before an 18:00 unload is the blocking constraint, and the remedy asks the haulier for a later truck', () => {
    const result = fit(reefer, [unload, plug, truck17], now);
    expect(result).toEqual({ blocking: { kind: 'truck-before-unload', truck: 'truck-17', unload: 'unload-18', departs: truck17.departs, ready: unload.at } });
    if (!('blocking' in result)) throw new Error('expected a blocking constraint');
    expect(describeConstraint(result.blocking)).toBe('The truck leaves at 17:00Z, before the container is unloaded at 18:00Z.');
    expect(remedyFor(result.blocking)).toEqual({ to: 'haulier', service: 'truck', after: unload.at });
  });
  test('the 19:30 truck fits: unload, powered storage across the wait, the truck, inside deadline and budget', () => {
    expect(fit(reefer, [unload, plug, truck17, truck1930], now)).toEqual({ plan: {
      unload: 'unload-18', storage: 'reefer-18-20', truck: 'truck-1930', ready: unload.at, departs: truck1930.departs,
      delivered: '2026-10-31T23:30:00.000Z', totalEur: 1200, offerIds: ['unload-18', 'reefer-18-20', 'truck-1930'],
    } });
  });
  test('when the 19:30 truck is withdrawn, the next truck and longer storage recover the plan on the same unload window', () => {
    const truck21: Offer = { ...truck1930, id: 'truck-21', departs: '2026-10-31T21:00:00.000Z' };
    expect(fit(reefer, [unload, plug, truck21], now)).toEqual({ blocking: { kind: 'storage-gap', storage: 'reefer-18-20', needFrom: unload.at, needUntil: truck21.departs } });
    const longer: Offer = { ...plug, id: 'reefer-18-22', until: '2026-10-31T22:00:00.000Z', priceEur: 250 };
    expect(fit(reefer, [unload, plug, longer, truck21], now)).toMatchObject({ plan: { unload: 'unload-18', storage: 'reefer-18-22', truck: 'truck-21' } });
  });
  test('a reefer is never planned without powered storage; an unpowered slot does not count', () => {
    const dry: Offer = { ...plug, id: 'dry', powered: false };
    expect(fit(reefer, [unload, dry, truck1930], now)).toMatchObject({ blocking: { kind: 'storage-gap' } });
    expect(fit({ ...reefer, reefer: false }, [unload, dry, truck1930], now)).toMatchObject({ plan: { storage: null, totalEur: 1050 } });
  });
  test('deadline and budget block a plan that otherwise fits, and an expired offer does not exist', () => {
    expect(fit({ ...reefer, deliverBy: '2026-10-31T23:00:00.000Z' }, [unload, plug, truck1930], now)).toMatchObject({ blocking: { kind: 'misses-deadline', truck: 'truck-1930' } });
    expect(fit({ ...reefer, budgetEur: 1000 }, [unload, plug, truck1930], now)).toEqual({ blocking: { kind: 'over-budget', totalEur: 1200, budgetEur: 1000 } });
    expect(fit(reefer, [unload, plug, { ...truck1930, expiresAt: now }], now)).toEqual({ blocking: { kind: 'missing', service: 'truck' } });
  });
  test('an unload window before the ship arrives is refused', () => {
    expect(fit(reefer, [{ ...unload, at: '2026-10-31T16:00:00.000Z' }, plug, truck1930], now)).toMatchObject({ blocking: { kind: 'unload-before-arrival' } });
  });
});

describe('recovery protocol', () => {
  const envelope = { id: 'm-1', at: now, summary: 'Need a later truck', caseId: 'case-1', answers: ['m-0'] };
  test('a request is the cargo agent asking a provider; a haulier cannot author one', () => {
    const request = { ...envelope, kind: 'recovery.request', author: { role: 'cargo', id: 'cargo-msc-reefer-1', vessel: 'Meridian Star' }, to: haulier, service: 'truck', after: unload.at };
    expect(recoveryMessage.safeParse(request).success).toBe(true);
    expect(recoveryMessage.safeParse({ ...request, author: haulier }).success).toBe(false);
  });
  test('an offer carries its terms; a truck offered by the terminal is refused', () => {
    expect(recoveryMessage.safeParse({ ...envelope, kind: 'recovery.offer', author: haulier, offer: truck1930 }).success).toBe(true);
    expect(recoveryMessage.safeParse({ ...envelope, kind: 'recovery.offer', author: terminal, offer: { ...truck1930, provider: terminal } }).success).toBe(false);
  });
  test('one booking key per case and offer', () => {
    expect(bookingKey('case-1', 'truck-1930')).toBe(bookingKey('case-1', 'truck-1930'));
    expect(bookingKey('case-1', 'truck-1930')).not.toBe(bookingKey('case-2', 'truck-1930'));
  });
});
