import { describe, expect, test } from 'bun:test';
import { fit, remedyFor, type Offer } from '../../src/core/recovery';
import { portIds } from '../../src/core/ports';
import { act2Anchor, plugOf, reeferAboard, reeferCommitments, servicesAt, terminalQuote, trucksFor, type Departure } from '../../src/core/services';

const anchor = '2026-11-13T09:00:00.000Z';
const hours = (h: number): string => new Date(Date.parse(anchor) + h * 3_600_000).toISOString();
const now = hours(-2);
const commitments = reeferCommitments(anchor);
const truckOffer = (truck: Departure): Offer => ({ service: 'truck', id: `rotterdam:truck:${truck.id}`, provider: { role: 'haulier', city: 'rotterdam' }, departs: truck.departs, priceEur: truck.priceEur, expiresAt: hours(1) });
const truckAfter = (after: string, withdrawn: readonly string[] = []): Offer =>
  truckOffer(trucksFor('rotterdam', anchor).find(truck => Date.parse(truck.departs) >= Date.parse(after) && !withdrawn.includes(truck.id))!);
const quote = (request: Parameters<typeof terminalQuote>[2]): Offer => terminalQuote('rotterdam', anchor, request, now)!;
const blockingOf = (offers: readonly Offer[]) => { const result = fit(commitments, offers, now); return 'blocking' in result ? result.blocking : null; };
const planOf = (offers: readonly Offer[]) => { const result = fit(commitments, offers, now); return 'plan' in result ? result.plan : null; };

/** ISO 6346, written here independently of the data: letters skip multiples of eleven, positions weigh 2^i, the sum mod 11 mod 10. */
const checkDigit = (code: string): number => {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').reduce<readonly number[]>((values, _, index) => {
    const next = (values[index - 1] ?? 9) + 1;
    return [...values, next % 11 === 0 ? next + 1 : next];
  }, []);
  const value = (char: string): number => /\d/.test(char) ? Number(char) : letters[char.charCodeAt(0) - 65]!;
  return code.slice(0, 10).split('').reduce((sum, char, index) => sum + value(char) * 2 ** index, 0) % 11 % 10;
};

describe('the act 2 sandbox', () => {
  test('the reefer box carries a valid ISO 6346 check digit', () => {
    expect(checkDigit('CSQU3054383')).toBe(3);
    expect(reeferAboard.container).toMatch(/^[A-Z]{3}U\d{7}$/);
    expect(checkDigit(reeferAboard.container)).toBe(Number(reeferAboard.container[10]));
  });

  test('the anchor is the original Rotterdam arrival on the hour, and the delay breaks the booked truck', () => {
    expect(act2Anchor({ baselineEta: '2026-11-13T09:41:12.345Z' })).toBe(anchor);
    expect(Date.parse(commitments.truckAppointment)).toBeLessThan(Date.parse(commitments.arrival));
    expect(Date.parse(commitments.arrival) - Date.parse(anchor)).toBe(reeferAboard.delayHours * 3_600_000);
  });

  test('the story the data tells, through the real solver: a conflict, a fit, a withdrawal and a recovery that keeps the unload', () => {
    const unload = quote({ service: 'unload', after: commitments.arrival });
    const power = quote({ service: 'storage', after: commitments.arrival });
    expect(unload).toMatchObject({ at: hours(8), priceEur: 140 });
    expect(power).toMatchObject({ from: hours(8), powered: true });

    const first = truckAfter(now);
    expect(blockingOf([unload, power, first])).toMatchObject({ kind: 'truck-before-unload', departs: hours(7), ready: hours(8) });
    const ask = remedyFor(blockingOf([unload, power, first])!)!;
    expect(ask).toMatchObject({ to: 'haulier', service: 'truck', after: hours(8) });

    const later = truckAfter(ask.after!);
    expect(later).toMatchObject({ departs: hours(9.5), priceEur: 720 });
    const gap = blockingOf([unload, power, first, later]);
    expect(gap).toMatchObject({ kind: 'storage-gap', needFrom: hours(8), needUntil: hours(9.5) });
    const covered = quote({ service: 'storage', after: hours(8), until: hours(9.5) });
    const plan = planOf([unload, power, first, later, covered])!;
    expect(plan).toMatchObject({ unload: unload.id, storage: covered.id, truck: later.id, delivered: hours(11.75), totalEur: 1002.5 });
    expect(Date.parse(plan.delivered)).toBeLessThanOrEqual(Date.parse(commitments.deliverBy));
    expect(plan.totalEur).toBeLessThanOrEqual(commitments.budgetEur);

    const withdrawn = [later.id.split(':').pop()!];
    const next = truckAfter(hours(8), withdrawn);
    expect(next).toMatchObject({ departs: hours(11), priceEur: 760 });
    expect(blockingOf([unload, covered, next])).toMatchObject({ kind: 'storage-gap', needUntil: hours(11) });
    const extended = quote({ service: 'storage', after: hours(8), until: hours(11) });
    const recovered = planOf([unload, covered, next, extended])!;
    expect(recovered).toMatchObject({ unload: unload.id, storage: extended.id, truck: next.id, delivered: hours(13.25), totalEur: 1185 });
    expect(Date.parse(recovered.delivered)).toBeLessThanOrEqual(Date.parse(commitments.deliverBy));
    expect(extended.id).not.toBe(covered.id);
  });

  test('a delay past the last crane window leaves nothing to unload, and a city without services offers nothing', () => {
    expect(terminalQuote('rotterdam', anchor, { service: 'unload', after: hours(9) }, now)).toBeNull();
    expect(terminalQuote('busan', anchor, { service: 'unload' }, now)).toBeNull();
    expect(trucksFor('busan', anchor)).toEqual([]);
    const departures = trucksFor('rotterdam', anchor).map(truck => Date.parse(truck.departs));
    expect(departures).toEqual(departures.toSorted((a, b) => a - b));
  });

  test('a city lists exactly the agents that answer there: Rotterdam\'s terminal desk and haulier, and no other city\'s', () => {
    const answering = (city: (typeof portIds)[number]): ReturnType<typeof servicesAt> => [
      ...(['unload', 'storage'] as const).some(service => terminalQuote(city, anchor, { service }, now) !== null) ? ['terminal' as const] : [],
      ...trucksFor(city, anchor).length > 0 ? ['haulier' as const] : [],
    ];
    expect(portIds.map(city => [city, servicesAt(city)])).toEqual(portIds.map(city => [city, answering(city)]));
    expect(servicesAt('rotterdam')).toEqual(['terminal', 'haulier']);
  });

  test('power is billed by the hour it covers, never past the plug\'s last free hour', () => {
    expect(quote({ service: 'storage', after: hours(8), until: hours(11) }).priceEur).toBe(285);
    expect(quote({ service: 'storage', after: hours(8), until: hours(30) })).toMatchObject({ until: hours(14), priceEur: 570 });
  });

  test('every storage interval on one plug is one ledger resource; other offers have none', () => {
    const short = quote({ service: 'storage', after: hours(8), until: hours(9.5) });
    const long = quote({ service: 'storage', after: hours(8), until: hours(11) });
    expect(plugOf(short.id)).toBe('rotterdam:plug:R-114');
    expect(plugOf(long.id)).toBe(plugOf(short.id));
    expect(plugOf(quote({ service: 'unload', after: hours(6) }).id)).toBeNull();
    expect(plugOf('rotterdam:truck:truck-1930')).toBeNull();
    expect(plugOf('atlantis:storage:R-1:2026-01-01T00:00:00.000Z/2026-01-01T01:00:00.000Z')).toBeNull();
  });
});
