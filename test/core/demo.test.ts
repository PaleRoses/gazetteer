import { describe, expect, test } from 'bun:test';
import { activePorts, assessDisruption, demoShipments } from '../../src/core/demo';
import { portById, ports } from '../../src/core/ports';
import { distanceKm, positionAlong, progressAt, routeLengthKm, sharedLengthKm, voyageRoute, type LngLat } from '../../src/core/routes';
import { relevance } from '../../src/server/agents/port/status';
import type { Disruption, Shipment } from '../../src/core/types';

const at = '2026-10-31T12:00:00.000Z';
const disruption: Disruption = { id: 'd-1', portId: 'singapore', delayHours: 36,
  evidence: { id: 'd-1', source: 'simulation', title: 'Berth closure', detail: 'Synthetic 36-hour berth closure.', observedAt: at } };

describe('synthetic shipment impact', () => {
  test('upcoming Singapore calls change, unaffected voyages do not', () => {
    const shipments = demoShipments(new Date(at));
    const updated = shipments.map(shipment => assessDisruption(shipment, disruption));
    const calling = shipments.filter(shipment => shipment.destination === 'singapore' || shipment.via.includes('singapore')).map(shipment => shipment.id);
    expect(updated.filter(shipment => shipment.risk === 'delayed').map(shipment => shipment.id)).toEqual(calling);
    expect(calling).toEqual(expect.arrayContaining(['gz-1042', 'gz-1044']));
    expect(updated.filter(shipment => shipment.risk === 'on-track')).toEqual(shipments.filter(shipment => !calling.includes(shipment.id)));
    expect(updated.filter(shipment => ['gz-1043', 'gz-1045'].includes(shipment.id)).every(shipment => shipment.risk === 'on-track')).toBe(true);
    expect(updated.every(shipment => shipment.delayHours === 0 || Date.parse(shipment.eta) - Date.parse(shipment.baselineEta) === 36 * 3_600_000)).toBe(true);
  });
  test('redelivery cannot compound the ETA and retains supporting evidence', () => {
    const shipment = demoShipments(new Date(at))[0]!;
    const updated = assessDisruption(shipment, disruption);
    expect(assessDisruption(updated, disruption)).toBe(updated);
    expect(updated.evidence).toEqual([disruption.evidence]);
    expect(updated.milestones[0]).toEqual(shipment.milestones[0]);
    expect(updated.action).not.toBeNull();
  });
  test('a small delay is a watch and distinct events accumulate exactly once', () => {
    const shipment = demoShipments(new Date(at))[0]!;
    const first = assessDisruption(shipment, { ...disruption, delayHours: 6 });
    expect(first.risk).toBe('watch');
    const second = assessDisruption(first, { ...disruption, id: 'd-2', delayHours: 12 });
    expect(second.delayHours).toBe(18);
    expect(Date.parse(second.eta) - Date.parse(second.baselineEta)).toBe(18 * 3_600_000);
  });
});

describe('the demo fleet', () => {
  const fleet = demoShipments(new Date(at));
  const byId = (id: string): Shipment => fleet.find(shipment => shipment.id === id)!;
  const sketched = new Set(['gz-1042', 'gz-1043', 'gz-1044', 'gz-1045']);
  const laned = fleet.filter(shipment => !sketched.has(shipment.id));
  const departed = (shipment: Shipment): string => shipment.milestones[0]!.at;
  const near = (route: readonly LngLat[], [lon, lat]: LngLat, km: number): boolean => route.some(point => distanceKm(point, [lon, lat]) < km);

  test('every table voyage sails its generated lane from origin to destination, and sits on it where its clock says', () => {
    laned.forEach(shipment => {
      const route = voyageRoute(shipment)!;
      expect(shipment.route).toEqual(route);
      expect(distanceKm(route[0]!, portById.get(shipment.origin)!.coordinates as LngLat)).toBeLessThan(1);
      expect(distanceKm(route[route.length - 1]!, portById.get(shipment.destination)!.coordinates as LngLat)).toBeLessThan(1);
      expect(distanceKm(shipment.coordinates, positionAlong(route, progressAt(departed(shipment), shipment.eta, Date.parse(at)))!)).toBeLessThan(1);
    });
  });

  test('each ETA follows from the lane length at a container service speed of 14 to 20 knots', () => {
    laned.forEach(shipment => {
      const knots = routeLengthKm(shipment.route) / 1.852 / ((Date.parse(shipment.eta) - Date.parse(departed(shipment))) / 3_600_000);
      expect({ id: shipment.id, fast: knots <= 20, slow: knots >= 14 }).toEqual({ id: shipment.id, fast: true, slow: true });
    });
  });

  test('the fleet sails the real trades: Suez, the transpacific, Panama, intra-Asia, the North Atlantic and South America', () => {
    const routes = laned.map(shipment => shipment.route);
    expect(routes.some(route => near(route, [32.5, 30.0], 150))).toBe(true);
    expect(routes.some(route => route.some(([lon]) => Math.abs(lon) > 180))).toBe(true);
    expect(routes.some(route => near(route, [-79.7, 9.1], 150))).toBe(true);
    expect(laned.some(shipment => ['singapore', 'shanghai', 'colombo'].includes(shipment.destination) && ['shanghai', 'port-klang', 'jebel-ali', 'singapore'].includes(shipment.origin))).toBe(true);
    expect(laned.some(shipment => ['rotterdam', 'piraeus'].includes(shipment.origin) && shipment.destination === 'new-york-new-jersey')).toBe(true);
    expect(laned.some(shipment => shipment.origin === 'santos' || shipment.destination === 'santos')).toBe(true);
  });

  test('a Suez lane has a Cape alternative that parts from it early, rounds Africa and is longer', () => {
    ['gz-1055', 'gz-1057', 'gz-1058'].forEach(id => {
      const suez = voyageRoute(byId(id))!;
      const cape = voyageRoute(byId(id), 'cape')!;
      expect(routeLengthKm(cape)).toBeGreaterThan(routeLengthKm(suez) * 1.2);
      expect(sharedLengthKm(suez, cape)).toBeLessThan(routeLengthKm(suez) / 4);
      expect(Math.min(...cape.map(([, lat]) => lat))).toBeLessThan(-30);
      expect(near(cape, [32.5, 30.0], 300)).toBe(false);
    });
    expect(voyageRoute(byId('gz-1043'), 'cape')).toBeUndefined();
  });

  test('a port actor runs exactly where the fleet still calls; a port that is only an origin has none', () => {
    const active = activePorts(fleet).map(port => port.id);
    expect(active).toEqual(ports.filter(port => relevance(fleet, port.id) > 0).map(port => port.id));
    expect(ports.some(port => fleet.some(shipment => shipment.origin === port.id) && !active.includes(port.id))).toBe(true);
    expect(activePorts([])).toEqual([]);
  });
});
