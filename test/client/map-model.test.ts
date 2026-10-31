import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../src/core/demo';
import { ports } from '../../src/core/ports';
import type { PortBulletin, PortStatus, TrafficReport } from '../../src/core/board';
import { distanceKm, routeLengthKm, voyageRoute } from '../../src/core/routes';
import { boundsOf, cameraFor, fleetPorts, regions, portFeatures, routeLayers, statusLine, vesselView, vesselViews } from '../../src/client/map-model';

const now = new Date('2026-10-31T12:00:00Z');
const shipments = demoShipments(now);
const need = <A>(value: A | undefined): A => { if (value === undefined) throw new Error('expected a value'); return value; };
const shanghaiLosAngeles = need(shipments.find(shipment => shipment.id === 'gz-1043'));

describe('port map features', () => {
  test('projects the supplied catalog in order at its canonical coordinates, without inventing risk or relevance', () => {
    const features = portFeatures(ports).features;
    expect(features.map(feature => feature.id)).toEqual(ports.map(port => port.id));
    expect(features.map(feature => feature.geometry.coordinates)).toEqual(ports.map(port => [...port.coordinates]));
    expect(features.every(feature => feature.properties.risk === 'unreported' && feature.properties.relevance === null)).toBe(true);
    expect(features.every(feature => feature.properties.label.includes('Risk unreported'))).toBe(true);
  });

  test('an explicit quiet status is normal even without a bulletin, and zero relevance stays visible', () => {
    const features = portFeatures(ports, [{ portId: 'singapore', risk: 'normal', relevance: 0, bulletin: null }]).features;
    expect(need(features.find(feature => feature.id === 'singapore')).properties).toEqual({
      id: 'singapore', name: 'Singapore', risk: 'normal', relevance: 0, anchored: null, label: 'Singapore\nNormal · 0 upcoming ships',
    });
    expect(need(features.find(feature => feature.id === 'busan')).properties.risk).toBe('unreported');
  });

  test.each(['normal', 'elevated', 'severe'] as const)('projects reported %s risk and relevance by canonical ID, not array position', risk => {
    const statuses: readonly PortStatus[] = [
      { portId: 'busan', risk, relevance: 1, bulletin: null },
      { portId: 'singapore', risk: 'normal', relevance: 3, bulletin: null },
    ];
    const properties = need(portFeatures(ports, statuses).features.find(feature => feature.id === 'busan')).properties;
    expect(properties.risk).toBe(risk);
    expect(properties.relevance).toBe(1);
    expect(properties.label).toContain('1 upcoming ship');
    expect(properties.label).not.toContain('1 upcoming ships');
  });

  test('replacement data removes old ports/status and incorporates changed names, positions and risk', () => {
    const busan = need(ports.find(port => port.id === 'busan'));
    const before = portFeatures(ports, [{ portId: 'busan', risk: 'normal', relevance: 0, bulletin: null }]);
    const after = portFeatures([{ ...busan, name: 'Busan updated', coordinates: [130, 36] }], [{ portId: 'busan', risk: 'severe', relevance: 4, bulletin: null }]);
    expect(need(before.features.find(feature => feature.id === 'busan')).properties.risk).toBe('normal');
    expect(after.features.map(feature => feature.id)).toEqual(['busan']);
    expect(need(after.features[0]).geometry.coordinates).toEqual([130, 36]);
    expect(need(after.features[0]).properties.label).toBe('Busan updated\nSevere · 4 upcoming ships');
    expect(need(portFeatures([busan], []).features[0]).properties).toMatchObject({ risk: 'unreported', relevance: null });
    expect(portFeatures([]).features).toEqual([]);
  });
  test('city badge is the latest anchored count, never relevance/arrivals; zero traffic overrides bulletin fallback', () => {
    const bulletin: PortBulletin = { id: 'p1', kind: 'port.bulletin', author: { role: 'port', id: 'singapore' }, at: '2026-10-31T12:00:00Z', summary: 'Port assessment', portId: 'singapore', risk: 'elevated', anchored: 7, arrivals48h: 99, evidenceIds: [] };
    const traffic: TrafficReport = { id: 't1', kind: 'city.traffic', author: { role: 'city', city: 'singapore', element: 'traffic' }, at: '2026-10-31T13:00:00Z', summary: 'Traffic assessment', risk: 'normal', anchored: 0, arrivals48h: 88, evidenceIds: [], basis: { perHour: 1, provenance: 'assumed', basis: 'Test assumption' } };
    const status: PortStatus = { portId: 'singapore', risk: 'elevated', relevance: 55, bulletin };
    const fallback = need(portFeatures(ports, [status]).features.find(feature => feature.id === 'singapore')).properties;
    expect(fallback.anchored).toBe(7);
    const current = need(portFeatures(ports, [status], [traffic, { ...traffic, id: 'older', at: '2026-10-31T11:00:00Z', anchored: 3 }, bulletin]).features.find(feature => feature.id === 'singapore')).properties;
    expect(current.anchored).toBe(0);
    expect(current.relevance).toBe(55);
    expect(current.label).toContain('0 anchored');
    expect(need(portFeatures(ports).features.find(feature => feature.id === 'singapore')).properties.anchored).toBeNull();
  });
});

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
  test('the selected voyage splits at the ship: the sailed leg ends where the remaining leg begins', () => {
    const layers = routeLayers(views, 'gz-1043');
    const sailed = need(layers.sailed.features[0]).geometry.coordinates;
    const ahead = need(layers.ahead.features[0]).geometry.coordinates;
    expect(sailed[sailed.length - 1]).toEqual(ahead[0]);
    expect(need(ahead[ahead.length - 1])).toEqual([...need(need(views.find(view => view.id === 'gz-1043')).route.at(-1))]);
  });

  test('with nothing selected no voyage is drawn', () => {
    const layers = routeLayers(views, undefined);
    expect(layers.sailed.features).toEqual([]);
    expect(layers.ahead.features).toEqual([]);
  });
});

describe('fleet cities and status', () => {
  test('only cities a voyage touches are kept, calls included', () => {
    const voyage = { ...shanghaiLosAngeles, origin: 'shanghai' as const, via: ['busan' as const], destination: 'singapore' as const };
    expect(fleetPorts(portFeatures(ports), [voyage]).features.map(feature => feature.id).sort()).toEqual(['busan', 'shanghai', 'singapore']);
    expect(fleetPorts(portFeatures(ports), []).features).toEqual([]);
  });

  test('a delay is stated in hours only when there is one', () => {
    expect(statusLine({ risk: 'delayed', delayHours: 6 })).toBe('Delayed · +6 h');
    expect(statusLine({ risk: 'watch', delayHours: 0 })).toBe('Watch');
    expect(statusLine({ risk: 'on-track', delayHours: 3 })).toBe('On track');
  });
});

describe('geometry helpers', () => {
  test('the whole world fits a wide viewport across and a tall one down, never wider than the screen', () => {
    const world = need(regions.find(region => region.id === 'world')).bounds;
    const wide = cameraFor(world, 1206, 691, 25);
    expect(512 * 2 ** wide.zoom).toBeCloseTo(1156, 6);
    const tall = cameraFor(world, 600, 300, 25);
    expect(512 * 2 ** tall.zoom).toBeLessThan(550);
    expect(cameraFor([-10, -10, 10, 10], 800, 800, 0).center).toEqual([0, expect.closeTo(0, 9)]);
  });

  test('bounds of a date-line route extend beyond 180 so the camera frames the Pacific', () => {
    const bounds = need(boundsOf(need(voyageRoute(shanghaiLosAngeles))));
    expect(bounds[2] - bounds[0]).toBeLessThan(150);
    expect(bounds[2]).toBeGreaterThan(180);
    expect(boundsOf([])).toBeUndefined();
  });
});
