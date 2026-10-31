import { cellToLatLng, gridDisk, latLngToCell } from 'h3-js';
import { distanceKm } from '../sources/geo';
import { zones as constants } from './constants';

type ZoneKind = 'berth' | 'anchorage' | 'outer';
export type ZoneRef = Readonly<{ portId: string; kind: ZoneKind }>;
export type PortArea = Readonly<{ id: string; coordinates: readonly [number, number] }>;
export type Router = Readonly<{ route: (lat: number, lon: number) => ZoneRef | undefined; cells: number }>;

const rings = Math.ceil(constants.outerKm / constants.centreSpacingKm);

const kindAt = (km: number): ZoneKind | undefined =>
  km <= constants.berthKm ? 'berth' : km <= constants.anchorageKm ? 'anchorage' : km <= constants.outerKm ? 'outer' : undefined;

type Box = Readonly<{ south: number; north: number; west: number; east: number }>;
const boxAround = ([lon, lat]: readonly [number, number]): Box => {
  const dLat = (constants.outerKm * constants.boxMargin) / constants.kmPerDegree;
  const dLon = dLat / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
};

/** Pure: builds the cell index once. A cell claimed by two ports belongs to the nearer (entries are ordered far-to-near so the nearer set wins). */
export const buildRouter = (ports: readonly PortArea[]): Router => {
  const entries = ports.flatMap(port =>
    gridDisk(latLngToCell(port.coordinates[1], port.coordinates[0], constants.resolution), rings).flatMap(cell => {
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
      ? cells.get(latLngToCell(lat, lon, constants.resolution)) : undefined,
  };
};
