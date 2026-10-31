import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import { ports } from '../../domain';
import type { Disruption, Shipment } from '../../shared';

export type Position = readonly [number, number];
export type NoticeGeometry = Readonly<{ center: Position; radiusKm: number }>;
export type AssessableNotice = Disruption & Readonly<{ geometry?: NoticeGeometry }>;

const transitProximityKm = 100;

const routePassesWithin = (route: readonly Position[], center: Position, radiusKm: number): boolean =>
  route.length > 1 && nearestPointOnLine(lineString(route.map(position => [...position])), point([...center]), { units: 'kilometers' }).properties.pointDistance <= radiusKm;

/** Pre-filter: unexposed shipments never reach the model. Only upcoming calls count, as in the deterministic model; the origin has departed. */
export function isExposed(shipment: Shipment, notice: AssessableNotice): boolean {
  const port = ports.find(value => value.id === notice.portId);
  return shipment.destination === notice.portId
    || shipment.via.includes(notice.portId)
    || (port !== undefined && port.id !== shipment.origin && routePassesWithin(shipment.route, port.coordinates, transitProximityKm))
    || (notice.geometry !== undefined && routePassesWithin(shipment.route, notice.geometry.center, notice.geometry.radiusKm));
}
