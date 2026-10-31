import { describe, expect, test } from 'bun:test';
import { ports } from '../../src/core/demo';
import type { PortId } from '../../src/core/types';
import { distanceKm, positionAlong, progressAt, routeLengthKm, routeThrough, splitAt, unwrap, voyageRoute, type LngLat } from '../../src/core/routes';

const port = (id: PortId): LngLat => (ports.find(item => item.id === id)?.coordinates ?? [NaN, NaN]) as LngLat;
const need = <A>(value: A | undefined): A => { if (value === undefined) throw new Error('expected a value'); return value; };
const steps = (route: readonly LngLat[]) => route.slice(1).map((point, index) => Math.abs(point[0] - (route[index] as LngLat)[0]));

describe('voyage routes', () => {
  test('start and end at the ports, in either direction', () => {
    const out = need(routeThrough(['shanghai', 'rotterdam']));
    const back = need(routeThrough(['rotterdam', 'shanghai']));
    expect(distanceKm(need(out[0]), port('shanghai'))).toBeLessThan(0.01);
    expect(distanceKm(need(out[out.length - 1]), port('rotterdam'))).toBeLessThan(0.01);
    expect(distanceKm(need(back[0]), port('rotterdam'))).toBeLessThan(0.01);
    expect(routeLengthKm(back)).toBeCloseTo(routeLengthKm(out), 6);
  });

  test('Shanghai to Los Angeles is continuous across the antimeridian', () => {
    const raw = need(routeThrough(['shanghai', 'los-angeles']));
    expect(Math.max(...steps(raw))).toBeLessThan(30);
    expect(Math.max(...raw.map(point => point[0]))).toBeGreaterThan(180);
    expect(distanceKm(need(raw[0]), port('shanghai'))).toBeLessThan(1);
    expect(distanceKm(need(raw[raw.length - 1]), port('los-angeles'))).toBeLessThan(1);
    expect(routeLengthKm(raw)).toBeGreaterThan(9_000);
    expect(routeLengthKm(raw)).toBeLessThan(13_000);
  });

  test('unwrap removes 360 degree jumps in either direction', () => {
    expect(Math.max(...steps(unwrap([[170, 30], [-175, 31], [-160, 33]])))).toBeLessThan(30);
    expect(Math.max(...steps(unwrap([[-170, 30], [175, 31], [160, 33]])))).toBeLessThan(30);
  });

  test('a via port is on the route and the legs add up', () => {
    const route = need(voyageRoute({ origin: 'shanghai', via: ['singapore'], destination: 'rotterdam' }));
    const nearest = Math.min(...route.map(point => distanceKm(point, port('singapore'))));
    expect(nearest).toBeLessThan(1);
    const legs = routeLengthKm(need(routeThrough(['shanghai', 'singapore']))) + routeLengthKm(need(routeThrough(['singapore', 'rotterdam'])));
    expect(routeLengthKm(route)).toBeCloseTo(legs, 3);
    expect(routeLengthKm(route)).toBeGreaterThan(distanceKm(port('shanghai'), port('rotterdam')) * 1.2);
  });

  test('a port pair outside the network has no route', () => {
    expect(routeThrough(['shanghai'])).toBeUndefined();
    expect(routeThrough(['shanghai', 'shanghai'])).toBeUndefined();
  });
});

describe('vessel position', () => {
  const route = need(routeThrough(['shanghai', 'los-angeles']));

  test('endpoints and clamping', () => {
    expect(distanceKm(need(positionAlong(route, 0)), port('shanghai'))).toBeLessThan(0.01);
    expect(distanceKm(need(positionAlong(route, 1)), port('los-angeles'))).toBeLessThan(1);
    expect(positionAlong(route, -3)).toEqual(positionAlong(route, 0));
    expect(positionAlong(route, 7)).toEqual(positionAlong(route, 1));
    expect(positionAlong([], 0.5)).toBeUndefined();
  });

  test('moves by equal distance per equal fraction, through the date line, without jumping the globe', () => {
    const samples = Array.from({ length: 41 }, (_, index) => need(positionAlong(route, index / 40)));
    const gaps = samples.slice(1).map((point, index) => distanceKm(point, need(samples[index])));
    const expected = routeLengthKm(route) / 40;
    for (const gap of gaps) expect(gap).toBeLessThan(expected * 1.05);
    expect(gaps.reduce((sum, gap) => sum + gap, 0)).toBeGreaterThan(routeLengthKm(route) * 0.9);
    expect(samples.some(point => point[0] > 150) && samples.some(point => point[0] < -150)).toBe(true);
    expect(samples.every(point => point[0] >= -180 && point[0] <= 180)).toBe(true);
  });

  test('split keeps the vessel at the seam and the whole route length', () => {
    const { sailed, ahead } = splitAt(route, 0.4);
    expect(need(sailed[sailed.length - 1])).toEqual(need(ahead[0]));
    expect(Math.abs(routeLengthKm(sailed) + routeLengthKm(ahead) - routeLengthKm(route))).toBeLessThan(1);
    expect(routeLengthKm(sailed) / routeLengthKm(route)).toBeCloseTo(0.4, 3);
  });
});

describe('progress', () => {
  const departed = '2026-10-31T00:00:00.000Z';
  const eta = '2026-11-10T00:00:00.000Z';
  test('is the elapsed share of the voyage, clamped', () => {
    expect(progressAt(departed, eta, Date.parse('2026-11-05T00:00:00.000Z'))).toBeCloseTo(0.5, 9);
    expect(progressAt(departed, eta, Date.parse('2026-10-01T00:00:00.000Z'))).toBe(0);
    expect(progressAt(departed, eta, Date.parse('2026-12-01T00:00:00.000Z'))).toBe(1);
  });
  test('a revised later ETA moves the vessel back, an unusable window leaves it at the origin', () => {
    const now = Date.parse('2026-11-05T00:00:00.000Z');
    expect(progressAt(departed, '2026-11-20T00:00:00.000Z', now)).toBeLessThan(progressAt(departed, eta, now));
    expect(progressAt(eta, departed, now)).toBe(0);
    expect(progressAt('not a date', eta, now)).toBe(0);
  });
});
