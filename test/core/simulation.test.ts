import { expect, test } from 'bun:test';
import { demoShipments } from '../../src/core/demo';
import { simulateDisruption } from '../../src/core/simulation';

const now = new Date('2026-10-31T12:00:00Z');
const fleet = demoShipments(now);
const ship = { ...fleet[0]!, destination: 'singapore' as const };
const input = { scenario: 'Dockworkers’ strike', portId: 'singapore' as const, delayHours: 36 };

test('scenario output is detached and repeated runs do not accumulate or mutate fleet data', () => {
  const ships = [structuredClone(ship)];
  const before = structuredClone(ships);
  Object.freeze(ships[0]); Object.freeze(ships);
  const first = simulateDisruption(ships, input, now.toISOString(), now);
  const second = simulateDisruption(ships, input, now.toISOString(), now);
  expect(first).toEqual(second);
  expect(ships).toEqual(before);
  expect(first.vessels).toHaveLength(1);
  expect(Date.parse(first.vessels[0]!.scenarioEta) - Date.parse(ship.eta)).toBe(36 * 3_600_000);
  expect(first.input).not.toBe(input);
  expect(first.vessels[0]).not.toBe(ship);
});

test('uses the current ETA even when it differs from baseline plus recorded delay', () => {
  const current = { ...ship, eta: '2026-11-10T12:00:00Z', delayHours: 90 };
  const result = simulateDisruption([current], input, now.toISOString(), now);
  expect(result.vessels[0]!.scenarioEta).toBe('2026-11-12T00:00:00.000Z');
});

test('only future destination arrivals are affected; origins, transit calls and completed voyages are excluded', () => {
  const result = simulateDisruption([
    ship,
    { ...ship, id: 'other', destination: 'rotterdam', origin: 'singapore', via: ['singapore'] },
    { ...ship, id: 'past', eta: now.toISOString() },
    { ...ship, id: 'arrived', voyage: { departure: now.toISOString(), eta: ship.eta, status: 'arrived', updatedAt: now.toISOString(), updatedBy: 'test', statusSince: now.toISOString(), source: 'operator' } },
  ], input, now.toISOString(), now);
  expect(result.vessels.map(item => item.id)).toEqual([ship.id]);
});

test('small assumptions never lower an existing high risk', () => {
  const result = simulateDisruption([{ ...ship, risk: 'delayed', delayHours: 0 }], { ...input, delayHours: 1 }, now.toISOString(), now);
  expect(result.vessels[0]!.risk).toBe('delayed');
});

test('empty scope is valid and invalid delays are rejected', () => {
  expect(simulateDisruption([], input, now.toISOString(), now).vessels).toEqual([]);
  for (const delayHours of [0, -1, 169, NaN, 1.5]) expect(() => simulateDisruption([ship], { ...input, delayHours }, now.toISOString(), now)).toThrow();
});
