import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../src/core/demo';
import { distanceKm, routeLengthKm, voyageRoute } from '../../src/core/routes';
import { boundsOf, graticule, routeLayers, vesselView, vesselViews } from '../../src/client/map-model';

const now = new Date('2026-10-31T12:00:00Z');
const shipments = demoShipments(now);
const need = <A>(value: A | undefined): A => { if (value === undefined) throw new Error('expected a value'); return value; };
const shanghaiLosAngeles = need(shipments.find(shipment => shipment.id === 'gz-1043'));

describe('vessel views', () => {
  test('a vessel sits on its own sea lane, between departure and arrival', () => {
    const view = vesselView(shanghaiLosAngeles, now.getTime());
    expect(view.laneSource).toBe('sea-lane');
    expect(view.progress).toBeGreaterThan(0.2);
    expect(view.progress).toBeLessThan(0.4);
    const nearest = Math.min(...view.route.map(point => distanceKm(point, view.position)));
    expect(nearest).toBeLessThan(routeLengthKm(view.route) / view.route.length * 1.5);
  });

  test('a delay moves the vessel back along the route', () => {
    const delayed = { ...shanghaiLosAngeles, eta: new Date(Date.parse(shanghaiLosAngeles.eta) + 72 * 3_600_000).toISOString() };
    expect(vesselView(delayed, now.getTime()).progress).toBeLessThan(vesselView(shanghaiLosAngeles, now.getTime()).progress);
  });

  test('a voyage without a lane falls back to the supplied route and keeps working', () => {
    const odd = { ...shanghaiLosAngeles, destination: 'shanghai' as const, origin: 'shanghai' as const };
    expect(voyageRoute(odd)).toBeUndefined();
    const view = vesselView(odd, now.getTime());
    expect(view.laneSource).toBe('supplied');
    expect(view.route.length).toBe(shanghaiLosAngeles.route.length);
  });

  test('every demo vessel has a position inside the world', () => {
    for (const view of vesselViews(shipments, now.getTime())) {
      expect(view.position[0]).toBeGreaterThanOrEqual(-180);
      expect(view.position[0]).toBeLessThanOrEqual(180);
      expect(Math.abs(view.position[1])).toBeLessThan(80);
    }
  });
});

describe('route layers', () => {
  const views = vesselViews(shipments, now.getTime());
  test('the selected voyage is split at the vessel and left out of the faint lanes', () => {
    const layers = routeLayers(views, 'gz-1043');
    expect(layers.lanes.features.map(feature => feature.properties?.id)).not.toContain('gz-1043');
    expect(layers.lanes.features.length).toBe(views.length - 1);
    const sailed = need(layers.sailed.features[0]).geometry.coordinates;
    const ahead = need(layers.ahead.features[0]).geometry.coordinates;
    expect(sailed[sailed.length - 1]).toEqual(ahead[0]);
  });

  test('with nothing selected every voyage is a faint lane', () => {
    const layers = routeLayers(views, undefined);
    expect(layers.lanes.features.length).toBe(views.length);
    expect(layers.sailed.features).toEqual([]);
  });
});

describe('geometry helpers', () => {
  test('bounds of a date-line route extend beyond 180 so the camera frames the Pacific', () => {
    const bounds = need(boundsOf(need(voyageRoute(shanghaiLosAngeles))));
    expect(bounds[2] - bounds[0]).toBeLessThan(150);
    expect(bounds[2]).toBeGreaterThan(180);
    expect(boundsOf([])).toBeUndefined();
  });
  test('graticule lines are meridians and parallels', () => {
    const lines = graticule(30).features;
    expect(lines.some(feature => feature.properties?.id === 'lat0')).toBe(true);
    expect(lines.some(feature => feature.properties?.id === 'lon-180')).toBe(true);
  });
});
