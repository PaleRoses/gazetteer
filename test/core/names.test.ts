import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../src/core/demo';
import { named, shipMindFor, shipMinds } from '../../src/core/names';

const fleet = demoShipments(new Date('2026-10-31T12:00:00.000Z'));

describe('ship minds', () => {
  test('every ship in the fleet has its own mind, in the catalogue order, and the catalogue outlasts the fleet', () => {
    expect(new Set(fleet.map(ship => ship.agent)).size).toBe(fleet.length);
    expect(fleet.map(ship => ship.agent)).toEqual(fleet.map((_, index) => shipMinds[index]));
    expect(shipMinds.length).toBeGreaterThanOrEqual(fleet.length);
    expect(new Set(shipMinds).size).toBe(shipMinds.length);
    expect(() => shipMindFor(shipMinds.length)).toThrow();
  });
  test('a name is a function of the place, so appending a ship renames no one, and no name carries a digit', () => {
    const later = demoShipments(new Date('2026-11-05T12:00:00.000Z'));
    expect(later.map(ship => ship.agent)).toEqual(fleet.map(ship => ship.agent));
    expect(shipMinds.every(name => !/\d/.test(name))).toBe(true);
  });
  test('a ship persisted before names is named once from its place in the fleet, and then keeps whatever name it has', () => {
    const { agent: _agent, ...old } = fleet[3]!;
    const ids = fleet.map(ship => ship.id);
    const first = named(old, ids);
    expect(first.agent).toBe(fleet[3]!.agent);
    expect(named({ ...first, agent: 'Elsewhere' }, ids).agent).toBe('Elsewhere');
    expect(named(first, [...ids].reverse()).agent).toBe(fleet[3]!.agent);
  });
});
