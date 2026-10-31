import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { distanceKm } from '../sources/geo';

type ZoneKind = 'berth' | 'anchorage' | 'outer';
export type ZoneRef = Readonly<{ portId: string; kind: ZoneKind }>;
export type PortArea = Readonly<{ id: string; coordinates: readonly [number, number] }>;
export type Router = Readonly<{ route: (lat: number, lon: number) => ZoneRef | undefined; cells: number }>;

/**
 * Zone radii around a port's reference point. berth and anchorage split the GFW "in port" radius; outer is the exit side of the
 * entry/exit asymmetry (a vessel inside it keeps its membership, GFW `_is_in_port`). The 30/40 km pair is the one in ../port/risk.ts;
 * the 5 km berth radius is this lane's estimate. All three are radius estimates, not AIS-derived zones: the cell sets in a baseline
 * artifact replace them where history exists.
 */
const zoneRadii = { berthKm: 5, anchorageKm: 30, outerKm: 40 } as const;
const zoneResolution = 7;
/** Hexagon centres at resolution 7 are about 2.12 km apart: this many rings cover the outer radius. */
const rings = Math.ceil(zoneRadii.outerKm / 2.12);

const kindAt = (km: number): ZoneKind | undefined =>
  km <= zoneRadii.berthKm ? 'berth' : km <= zoneRadii.anchorageKm ? 'anchorage' : km <= zoneRadii.outerKm ? 'outer' : undefined;

type Box = Readonly<{ south: number; north: number; west: number; east: number }>;
const boxAround = ([lon, lat]: readonly [number, number]): Box => {
  const dLat = (zoneRadii.outerKm * 1.1) / 111;
  const dLon = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
};

/** Pure: builds the cell index once. A cell claimed by two ports belongs to the nearer (entries are ordered far-to-near so the nearer set wins). */
export const buildRouter = (ports: readonly PortArea[]): Router => {
  const entries = ports.flatMap(port =>
    gridDisk(latLngToCell(port.coordinates[1], port.coordinates[0], zoneResolution), rings).flatMap(cell => {
      const [lat, lon] = cellToLatLng(cell);
      const km = distanceKm(port.coordinates, [lon, lat]);
      const kind = kindAt(km);
      return kind ? [{ cell, km, zone: { portId: port.id, kind } as ZoneRef }] : [];
    }));
  const cells = new Map(entries.sort((a, b) => b.km - a.km).map(entry => [entry.cell, entry.zone] as const));
  const boxes = ports.map(port => boxAround(port.coordinates));
  return {
    cells: cells.size,
    route: (lat, lon) => boxes.some(box => lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east)
      ? cells.get(latLngToCell(lat, lon, zoneResolution)) : undefined,
  };
};
