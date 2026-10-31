import { describe, expect, test } from 'bun:test';
import { project, routePath } from './map-geometry';

describe('map route projection', () => {
  test('keeps ordinary routes continuous', () => {
    expect(project([0, 0])).toEqual([500, 250]);
    expect(routePath([[0, 0], [36, 18]])).toBe('M500,250 L600,200');
    expect(routePath([])).toBe('');
  });

  test('splits eastbound and westbound date-line crossings at matching latitudes', () => {
    expect(routePath([[144, 0], [-144, 36]])).toBe('M900,250 L1000,200 M0,200 L100,150');
    expect(routePath([[-144, 0], [144, 36]])).toBe('M100,250 L0,200 M1000,200 L900,150');
  });

  test('handles routes that explicitly touch the date line', () => {
    expect(routePath([[180, 0], [-144, 0]])).toBe('M1000,250 L1000,250 M0,250 L100,250');
    expect(routePath([[-180, 0], [144, 0]])).toBe('M0,250 L0,250 M1000,250 L900,250');
    expect(routePath([[-180, 0], [180, 36]])).toBe('M0,250 M1000,250 L1000,150');
  });
});
