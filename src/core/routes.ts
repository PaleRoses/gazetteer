import type { PortId } from './ports.js';
import { seaLanes } from './lanes.generated.js';

export type LngLat = readonly [number, number];
export type Route = readonly LngLat[];

const EARTH_RADIUS_KM = 6371.0088;
const radians = (degrees: number): number => degrees * Math.PI / 180;

/** Great-circle distance, indifferent to longitude wrapping. */
export const distanceKm = ([lonA, latA]: LngLat, [lonB, latB]: LngLat): number => {
  const half = (x: number): number => Math.sin(radians(x) / 2) ** 2;
  const a = half(latB - latA) + Math.cos(radians(latA)) * Math.cos(radians(latB)) * half(lonB - lonA);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
};

const wrapLongitude = (longitude: number): number => ((((longitude + 180) % 360) + 360) % 360) - 180;
const wrap = ([lon, lat]: LngLat): LngLat => [wrapLongitude(lon), lat];

/** Makes longitudes continuous so a date-line crossing continues past ±180 instead of jumping 360 degrees. */
export const unwrap = (line: Route): Route =>
  line.reduce<readonly LngLat[]>((done, [lon, lat]) => {
    const previous = done[done.length - 1];
    if (!previous) return [[lon, lat]];
    const turns = Math.round((previous[0] - lon) / 360);
    return [...done, [lon + 360 * turns, lat]];
  }, []);

/** 'shortest' is the network's shortest path; 'cape' is the same pair with Suez and Bab-el-Mandeb closed (generated only where that differs). */
type Lane = 'shortest' | 'cape';
const laneKey = (from: PortId, to: PortId, lane: Lane): string => `${from}>${to}${lane === 'cape' ? '#cape' : ''}`;

const leg = (from: PortId, to: PortId, lane: Lane): Route | undefined => {
  const forward = seaLanes[laneKey(from, to, lane)];
  if (forward) return forward;
  const backward = seaLanes[laneKey(to, from, lane)];
  return backward ? [...backward].reverse() : undefined;
};

/** Ocean route through the ports in order; undefined when any consecutive pair has no lane. */
export const routeThrough = (stops: readonly PortId[], lane: Lane = 'shortest'): Route | undefined => {
  const legs = stops.slice(1).map((stop, index) => leg(stops[index] as PortId, stop, lane));
  if (legs.length === 0 || legs.some(part => part === undefined)) return undefined;
  return unwrap(legs.flatMap((part, index) => index === 0 ? part ?? [] : (part ?? []).slice(1)));
};

export const voyageRoute = (voyage: Readonly<{ origin: PortId; via: readonly PortId[]; destination: PortId }>, lane: Lane = 'shortest'): Route | undefined =>
  routeThrough([voyage.origin, ...voyage.via, voyage.destination], lane);

const segmentLengths = (route: Route): readonly number[] => route.slice(1).map((point, index) => distanceKm(route[index] as LngLat, point));
export const routeLengthKm = (route: Route): number => segmentLengths(route).reduce((sum, length) => sum + length, 0);

/** How far two routes from the same origin run together: the length of their common leading points. */
export const sharedLengthKm = (a: Route, b: Route): number => {
  const parted = a.findIndex((point, index) => b[index]?.[0] !== point[0] || b[index]?.[1] !== point[1]);
  return routeLengthKm(a.slice(0, parted === -1 ? a.length : parted));
};

const clamp01 = (value: number): number => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

type Cut = Readonly<{ index: number; point: LngLat }>;
const cutAt = (route: Route, fraction: number): Cut | undefined => {
  const first = route[0];
  if (!first) return undefined;
  const lengths = segmentLengths(route);
  const target = clamp01(fraction) * lengths.reduce((sum, length) => sum + length, 0);
  const found = lengths.reduce<Readonly<{ walked: number; hit: Cut | undefined }>>((state, length, index) => {
    if (state.hit || state.walked + length < target) return { walked: state.walked + length, hit: state.hit };
    const from = route[index] as LngLat;
    const to = route[index + 1] as LngLat;
    const t = length === 0 ? 0 : (target - state.walked) / length;
    return { walked: state.walked + length, hit: { index, point: [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t] } };
  }, { walked: 0, hit: undefined });
  const last = route[route.length - 1] as LngLat;
  return found.hit ?? { index: Math.max(0, route.length - 2), point: route.length > 1 ? last : first };
};

/** Position after travelling `fraction` of the route by distance, normalised to [-180, 180]. */
export const positionAlong = (route: Route, fraction: number): LngLat | undefined => {
  const cut = cutAt(route, fraction);
  return cut && wrap(cut.point);
};

/** The route split at the vessel: the sailed part and the part ahead, both including the vessel's point. */
export const splitAt = (route: Route, fraction: number): Readonly<{ sailed: Route; ahead: Route }> => {
  const cut = cutAt(route, fraction);
  if (!cut) return { sailed: [], ahead: [] };
  return { sailed: [...route.slice(0, cut.index + 1), cut.point], ahead: [cut.point, ...route.slice(cut.index + 1)] };
};

/** Fraction of the voyage elapsed between departure and the current ETA. A later ETA stretches the voyage. */
export const progressAt = (departedAt: string, eta: string, now: number): number => {
  const start = Date.parse(departedAt);
  const end = Date.parse(eta);
  return end > start ? clamp01((now - start) / (end - start)) : 0;
};
