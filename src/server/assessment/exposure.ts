import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import { ports } from '../../core/ports';
import { voyageRoute } from '../../core/routes';
import type { Disruption, Shipment } from '../../core/types';

export type Position = readonly [number, number];
export type NoticeGeometry = Readonly<{ center: Position; radiusKm: number }>;
export type AssessableNotice = Disruption & Readonly<{ geometry?: NoticeGeometry }>;

const transitProximityKm = 100;

const routePassesWithin = (route: readonly Position[], center: Position, radiusKm: number): boolean =>
  route.length > 1 && nearestPointOnLine(lineString(route.map(position => [...position])), point([...center]), { units: 'kilometers' }).properties.pointDistance <= radiusKm;

const routeOf = (shipment: Shipment): readonly Position[] => voyageRoute(shipment) ?? shipment.route;

/**
 * Pre-filter: unexposed shipments never reach the model. Only upcoming calls count, as in the deterministic model; the origin has departed.
 * A lane-scoped notice names a port only as its reporter, so it is exposed by route proximity to its geometry alone.
 */
export function isExposed(shipment: Shipment, notice: AssessableNotice): boolean {
  const route = routeOf(shipment);
  const nearGeometry = notice.geometry !== undefined && routePassesWithin(route, notice.geometry.center, notice.geometry.radiusKm);
  if (notice.scope === 'lane') return nearGeometry;
  const port = ports.find(value => value.id === notice.portId);
  return shipment.destination === notice.portId
    || shipment.via.includes(notice.portId)
    || (port !== undefined && port.id !== shipment.origin && routePassesWithin(route, port.coordinates, transitProximityKm))
    || nearGeometry;
}
