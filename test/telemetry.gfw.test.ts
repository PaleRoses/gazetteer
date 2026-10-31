import { describe, expect, test } from 'bun:test';
import { advanceTrack, currentLoitering, emptyTrack, gfwDefaults, isInPort, isOpenGap, isStopped, portEvents, type Fix, type PortState, type Track } from '../src/server/telemetry';

const p = gfwDefaults;
const t0 = Date.parse('2026-10-31T00:00:00.000Z');
const at = (minutes: number): string => new Date(t0 + minutes * 60_000).toISOString();
const step = (track: Track, minutes: number, sogKnots: number | null, nearestPortKm: number | null): Track =>
  advanceTrack(p, track, { at: at(minutes), position: [24, 60], sogKnots, nearestPortKm });

describe('pipe-anchorages hysteresis', () => {
  test('entry at 3 km, exit at 4 km, and in between the previous answer holds', () => {
    expect(isInPort(p, false, 3)).toBe(true);
    expect(isInPort(p, false, 3.5)).toBe(false);
    expect(isInPort(p, true, 3.5)).toBe(true);
    expect(isInPort(p, true, 4)).toBe(false);
    expect(isInPort(p, true, null)).toBe(false);
  });
  test('stopped at 0.2 kn, moving at 0.5 kn, and in between the previous answer holds', () => {
    expect(isStopped(p, false, 0.2)).toBe(true);
    expect(isStopped(p, false, 0.3)).toBe(false);
    expect(isStopped(p, true, 0.3)).toBe(true);
    expect(isStopped(p, true, 0.5)).toBe(false);
  });
  test('the transition map is theirs, all nine pairs', () => {
    const states: readonly PortState[] = ['AT_SEA', 'IN_PORT', 'STOPPED'];
    const table = states.flatMap(from => states.map(to => `${from}>${to}:${portEvents(from, to).join('+')}`));
    expect(table).toEqual([
      'AT_SEA>AT_SEA:', 'AT_SEA>IN_PORT:PORT_ENTRY', 'AT_SEA>STOPPED:PORT_ENTRY+PORT_STOP_BEGIN',
      'IN_PORT>AT_SEA:PORT_EXIT', 'IN_PORT>IN_PORT:', 'IN_PORT>STOPPED:PORT_STOP_BEGIN',
      'STOPPED>AT_SEA:PORT_STOP_END+PORT_EXIT', 'STOPPED>IN_PORT:PORT_STOP_END', 'STOPPED>STOPPED:',
    ]);
    expect(portEvents(null, 'STOPPED')).toEqual([]);
  });
  test('a voyage in and out of port produces the entry, stop, start and exit events in order', () => {
    const fixes = [[0, 8, 20], [10, 5, 3.5], [20, 4, 2], [30, 0.1, 1], [40, 0.4, 1], [50, 0.6, 1.5], [60, 6, 4.5]] as const;
    const events = fixes.reduce<Readonly<{ track: Track; seen: readonly string[] }>>((acc, [m, sog, km]) => {
      const track = step(acc.track, m, sog, km);
      return { track, seen: [...acc.seen, ...track.lastEvents] };
    }, { track: emptyTrack, seen: [] }).seen;
    expect(events).toEqual(['PORT_ENTRY', 'PORT_STOP_BEGIN', 'PORT_STOP_END', 'PORT_EXIT']);
  });
  test('a position no newer than the last is ignored, so a polled stale report never re-fires', () => {
    const first = step(emptyTrack, 0, 0.1, 20);
    expect(step(first, 0, 8, 1)).toBe(first);
    expect(step(first, -5, 8, 1)).toBe(first);
  });
  test('an unreported speed keeps the previous stopped state', () => {
    expect(step(step(emptyTrack, 0, 0.1, 20), 5, null, 20).stopped).toBe(true);
  });
});

describe('pipe-gaps', () => {
  test('a gap is strictly longer than 12 hours', () => {
    expect(isOpenGap(p, 12)).toBe(false);
    expect(isOpenGap(p, 12.01)).toBe(true);
  });
});

describe('pipe-loitering hourly buckets', () => {
  const along = (minutes: number, lonStep: number): Fix => ({ at: at(minutes), position: [24 + minutes * lonStep, 60] });
  test('consecutive slow hours ending at the latest fix are one loitering run', () => {
    const fixes = Array.from({ length: 13 }, (_, i) => along(i * 20, 0.000005));
    const run = currentLoitering(p, fixes)!;
    expect(run.hours).toBeCloseTo(4, 5);
    expect(run.avgKnots).toBeLessThan(0.1);
  });
  test('a fast final hour ends the run; a fast hour in the middle cuts it short', () => {
    const slow = Array.from({ length: 9 }, (_, i) => along(i * 20, 0.000005));
    const fastTail: Fix = { at: at(180), position: [24.2, 60] };
    expect(currentLoitering(p, [...slow, fastTail])).toBeNull();
    const mixed: Fix[] = [along(0, 0), { at: at(20), position: [24.001, 60] }, { at: at(40), position: [24.001, 60] }, { at: at(60), position: [24.5, 60] }, { at: at(80), position: [24.5001, 60] }, { at: at(100), position: [24.5001, 60] }, { at: at(120), position: [24.5002, 60] }];
    const run = currentLoitering(p, mixed)!;
    expect(run.hours).toBeCloseTo(1 / 3, 5);
  });
  test('the slow threshold is GFW 2 knots, from displacement over time, not reported speed', () => {
    const knotsToLon = (knots: number): number => knots * 1.852 / 111.32 / Math.cos(60 * Math.PI / 180);
    const fixesAt = (knots: number): Fix[] => [0, 60, 120].map(m => ({ at: at(m), position: [24 + knotsToLon(knots) * m / 60, 60] }));
    expect(currentLoitering(p, fixesAt(1.9))).not.toBeNull();
    expect(currentLoitering(p, fixesAt(2.1))).toBeNull();
  });
});
