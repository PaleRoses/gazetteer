import { ports } from '../../domain';
import type { Disruption, Shipment } from '../../shared';

export type Position = readonly [number, number];
export type NoticeGeometry = Readonly<{ center: Position; radiusKm: number }>;
export type AssessableNotice = Disruption & Readonly<{ geometry?: NoticeGeometry }>;

const earthKm = 6371;
const transitProximityKm = 100;
const stepKm = 40;
const rad = (degrees: number): number => degrees * Math.PI / 180;
const wrap = (degrees: number): number => ((degrees + 540) % 360) - 180;

export const distanceKm = ([lon1, lat1]: Position, [lon2, lat2]: Position): number => {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(wrap(lon2 - lon1)) / 2) ** 2;
  return 2 * earthKm * Math.asin(Math.sqrt(a));
};

const segmentPoints = ([from, to]: readonly [Position, Position]): readonly Position[] => {
  const steps = Math.max(1, Math.ceil(distanceKm(from, to) / stepKm));
  return Array.from({ length: steps + 1 }, (_, index): Position => [wrap(from[0] + wrap(to[0] - from[0]) * index / steps), from[1] + (to[1] - from[1]) * index / steps]);
};

const routePassesWithin = (route: readonly Position[], center: Position, radiusKm: number): boolean =>
  route.slice(1).some((to, index) => segmentPoints([route[index]!, to]).some(point => distanceKm(point, center) <= radiusKm));

/** Pre-filter: unexposed shipments never reach the model. Only upcoming calls count, as in the deterministic model; the origin has departed. */
export function isExposed(shipment: Shipment, notice: AssessableNotice): boolean {
  const port = ports.find(value => value.id === notice.portId);
  return shipment.destination === notice.portId
    || shipment.via.includes(notice.portId)
    || (port !== undefined && port.id !== shipment.origin && routePassesWithin(shipment.route, port.coordinates, transitProximityKm))
    || (notice.geometry !== undefined && routePassesWithin(shipment.route, notice.geometry.center, notice.geometry.radiusKm));
}
