import type { PortId } from '../../core/ports';
import { distanceToGeometryKm, nearestOnPath } from './geo';
import type { LonLat, Notice, NoticeKind } from './notice';

/** Declared reach of each hazard, in kilometres. Cyclone: gale-force wind field plus margin. Flood: GDACS places a flood at a regional centroid. */
export const radiusKm: Readonly<Record<NoticeKind, number>> = {
  cyclone: 600, flood: 150, volcano: 200, earthquake: 150, weather: 0, security: 100,
};

/** A notice with no feed-declared end stays relevant this long after it was last observed. */
const relevanceHours: Readonly<Record<NoticeKind, number>> = {
  cyclone: 48, flood: 72, volcano: 72, earthquake: 72, weather: 12, security: 168,
};

export type Place = Readonly<{ id: PortId; name: string; coordinates: LonLat }>;
export type Lane = Readonly<{ id: string; path: readonly LonLat[] }>;
export type PortHit = Readonly<{ portId: PortId; distanceKm: number; radiusKm: number; basis: 'distance' | 'declared-zone' | 'nearest-to-lane' }>;
export type LaneHit = Readonly<{ laneId: string; segment: number; distanceKm: number; radiusKm: number }>;
export type Exposure = Readonly<{ ports: readonly PortHit[]; lanes: readonly LaneHit[] }>;

const hours = (milliseconds: number): number => milliseconds / 3_600_000;

export const isActive = (notice: Notice, now: Date): boolean =>
  notice.expiresAt === null
    ? hours(now.getTime() - Date.parse(notice.observedAt)) <= relevanceHours[notice.kind]
    : Date.parse(notice.expiresAt) > now.getTime();

const portHit = (notice: Notice, place: Place): PortHit | null => {
  const radius = radiusKm[notice.kind];
  if (notice.geometry.kind === 'zone') return notice.geometry.portIds.includes(place.id)
    ? { portId: place.id, distanceKm: 0, radiusKm: radius, basis: 'declared-zone' } : null;
  const distance = distanceToGeometryKm(notice.geometry, place.coordinates);
  return distance !== null && distance <= radius ? { portId: place.id, distanceKm: distance, radiusKm: radius, basis: 'distance' } : null;
};

const laneHit = (notice: Notice, lane: Lane): LaneHit | null => {
  const hit = nearestOnPath(notice.geometry, lane.path);
  return hit !== null && hit.distanceKm <= radiusKm[notice.kind]
    ? { laneId: lane.id, segment: hit.segment, distanceKm: hit.distanceKm, radiusKm: radiusKm[notice.kind] } : null;
};

const present = <A>(value: A | null): value is A => value !== null;

/** Which ports and route segments a notice reaches, with the distance as evidence. Zone notices reach only their declared ports. */
export const exposure = (notice: Notice, places: readonly Place[], lanes: readonly Lane[]): Exposure => ({
  ports: places.map(place => portHit(notice, place)).filter(present),
  lanes: notice.geometry.kind === 'zone' ? [] : lanes.map(lane => laneHit(notice, lane)).filter(present),
});

/** The port closest to a located notice; zone notices name their ports and have no position. */
export const nearestPort = (notice: Notice, places: readonly Place[]): Readonly<{ place: Place; distanceKm: number }> | null =>
  places
    .flatMap(place => { const distance = distanceToGeometryKm(notice.geometry, place.coordinates); return distance === null ? [] : [{ place, distanceKm: distance }]; })
    .reduce<Readonly<{ place: Place; distanceKm: number }> | null>((best, candidate) => best === null || candidate.distanceKm < best.distanceKm ? candidate : best, null);

export const evidenceLine = (hit: PortHit, name: string, lanes: readonly LaneHit[] = []): string => {
  const lane = lanes.map(found => `${found.laneId} (${Math.round(found.distanceKm)} km off the track)`).join(', ');
  switch (hit.basis) {
    case 'declared-zone': return `${name} lies inside the notice's declared forecast zone.`;
    case 'distance': return `${Math.round(hit.distanceKm)} km from ${name} (reach ${hit.radiusKm} km).`;
    case 'nearest-to-lane': return `Reaches no port; it crosses the sea lane of ${lane}. ${name} is the nearest port, ${Math.round(hit.distanceKm)} km away, and reports it.`;
  }
};
