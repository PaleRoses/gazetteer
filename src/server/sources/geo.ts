import distance from '@turf/distance';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import type { LonLat, NoticeGeometry } from './notice';

const km = { units: 'kilometers' } as const;

export const distanceKm = (from: LonLat, to: LonLat): number => distance(point([...from]), point([...to]), km);

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Nearest point of a bbox to a position; the position itself when inside. */
const nearestInBbox = (box: Extract<NoticeGeometry, { kind: 'bbox' }>, at: LonLat): LonLat =>
  [clamp(at[0], box.west, box.east), clamp(at[1], box.south, box.north)];

/** Representative points of a geometry: its point, or a bbox's centre and corners. Zones carry no coordinates. */
export const anchors = (geometry: NoticeGeometry): readonly LonLat[] => {
  switch (geometry.kind) {
    case 'point': return [geometry.coordinates];
    case 'bbox': return [
      [(geometry.west + geometry.east) / 2, (geometry.south + geometry.north) / 2],
      [geometry.west, geometry.south], [geometry.west, geometry.north], [geometry.east, geometry.south], [geometry.east, geometry.north],
    ];
    case 'zone': return [];
  }
};

/** Great-circle distance from a position to a geometry; 0 inside a bbox. */
export const distanceToGeometryKm = (geometry: NoticeGeometry, at: LonLat): number | null => {
  switch (geometry.kind) {
    case 'point': return distanceKm(geometry.coordinates, at);
    case 'bbox': return distanceKm(nearestInBbox(geometry, at), at);
    case 'zone': return null;
  }
};

export type PathHit = Readonly<{ distanceKm: number; segment: number }>;

/** Nearest approach of a geometry to a polyline. turf's geodesic nearest-point handles routes that cross the antimeridian. */
export const nearestOnPath = (geometry: NoticeGeometry, path: readonly LonLat[]): PathHit | null => {
  const line = lineString(path.map(position => [...position]));
  return anchors(geometry)
    .map((position): PathHit => {
      const nearest = nearestPointOnLine(line, point([...position]), km);
      return { distanceKm: nearest.properties.dist ?? Number.POSITIVE_INFINITY, segment: nearest.properties.index ?? 0 };
    })
    .reduce<PathHit | null>((best, hit) => best === null || hit.distanceKm < best.distanceKm ? hit : best, null);
};
