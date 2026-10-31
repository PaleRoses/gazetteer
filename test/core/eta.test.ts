import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../src/core/demo';
import { shiftEta } from '../../src/core/eta';

const ship = demoShipments(new Date('2026-10-31T12:00:00.000Z'))[0]!;
const hours = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 3_600_000;

describe('shiftEta', () => {
  test('moves every milestone not yet complete by exactly the delta and leaves the complete ones', () => {
    const moved = shiftEta(ship, 7);
    moved.milestones.forEach((milestone, index) => {
      const before = ship.milestones[index]!;
      expect(hours(before.at, milestone.at)).toBe(before.status === 'complete' ? 0 : 7);
    });
    expect(ship.milestones.some(milestone => milestone.status === 'complete')).toBe(true);
    expect(ship.milestones.some(milestone => milestone.status !== 'complete')).toBe(true);
  });
  test('zero is the identity', () => expect(shiftEta(ship, 0)).toBe(ship));
  test('a then b equals a + b, negative deltas relax, and the eta is the baseline plus the total delay', () => {
    const stepped = shiftEta(shiftEta(ship, 10), -4);
    expect(stepped).toEqual(shiftEta(ship, 6));
    expect(hours(stepped.baselineEta, stepped.eta)).toBe(stepped.delayHours);
    expect(stepped.delayHours).toBe(ship.delayHours + 6);
  });
});
