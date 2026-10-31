import { describe, expect, test } from 'bun:test';
import { anchoredMinDwellSeconds, step, type VesselState } from '../../../src/server/ingest/anchorage';
import { buildRouter } from '../../../src/server/ingest/zones';
import { at, frame, laPort } from './fixtures';

const router = buildRouter([laPort]);
const advance = (previous: VesselState | undefined, f: ReturnType<typeof frame>): VesselState | undefined => step(previous, router.route(f.lat, f.lon), f);
const mmsi = 367123456;

describe('the anchorage reducer', () => {
  test('a vessel stopped in the anchorage is only approaching until it has been stationary for the dwell', () => {
    const first = advance(undefined, frame(mmsi, 1_000, at.anchorage));
    expect(first?.mode).toBe('approach');
    expect(advance(first, frame(mmsi, 1_000 + anchoredMinDwellSeconds - 1, at.anchorage))?.mode).toBe('approach');
    expect(advance(first, frame(mmsi, 1_000 + anchoredMinDwellSeconds, at.anchorage))?.mode).toBe('anchored');
  });

  test('moving again resets the dwell: the next stop starts a new clock', () => {
    const stopped = advance(undefined, frame(mmsi, 1_000, at.anchorage));
    const moved = advance(stopped, frame(mmsi, 2_000, at.anchorage, 2));
    expect(moved?.pendingSince).toBeNull();
    const again = advance(moved, frame(mmsi, 3_000, at.anchorage, 0.1));
    expect(advance(again, frame(mmsi, 3_000 + anchoredMinDwellSeconds - 1, at.anchorage))?.mode).toBe('approach');
  });

  test('speed hysteresis: between the stopping and starting speeds the previous answer holds', () => {
    const stopped = advance(undefined, frame(mmsi, 1_000, at.anchorage, 0.1));
    expect(advance(stopped, frame(mmsi, 1_100, at.anchorage, 0.3))?.stopped).toBe(true);
    const moving = advance(stopped, frame(mmsi, 1_100, at.anchorage, 0.9));
    expect(advance(moving, frame(mmsi, 1_200, at.anchorage, 0.3))?.stopped).toBe(false);
  });

  test('a vessel stopped at the berth radius is berthed, never anchored', () => {
    expect(advance(undefined, frame(mmsi, 1_000, at.berth))?.mode).toBe('berthed');
  });

  test('the outer ring admits nobody but keeps whoever is already in', () => {
    expect(advance(undefined, frame(mmsi, 1_000, at.outer, 5))).toBeUndefined();
    const inside = advance(undefined, frame(mmsi, 1_000, at.anchorage, 5));
    expect(advance(inside, frame(mmsi, 1_100, at.outer, 5))?.mode).toBe('approach');
    expect(advance(inside, frame(mmsi, 1_100, at.open, 5))).toBeUndefined();
  });

  test('a stopped vessel in the outer ring is not counted as anchored however long it stays', () => {
    const inside = advance(undefined, frame(mmsi, 1_000, at.anchorage, 5));
    expect(advance(inside, frame(mmsi, 1_000 + 3 * anchoredMinDwellSeconds, at.outer, 0))?.mode).toBe('approach');
  });

  test('a frame not newer than the last changes nothing', () => {
    const first = advance(undefined, frame(mmsi, 1_000, at.anchorage));
    expect(advance(first, frame(mmsi, 999, at.berth))).toBe(first);
    expect(advance(first, frame(mmsi, 1_000, at.berth))).toBe(first);
  });
});
