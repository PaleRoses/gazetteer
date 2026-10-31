import type { Frame } from '../../../src/server/ingest/frame';

export const laPort = { id: 'los-angeles', coordinates: [-118.26, 33.74] as const };
/** Positions at known distances south of the LA reference point (1 degree of latitude is 111.2 km). */
export const at = { berth: [-118.26, 33.74], anchorage: [-118.26, 33.605], outer: [-118.26, 33.425], open: [-118.26, 33.2] } as const;
export const cargo = 70;

export const frame = (mmsi: number, seconds: number, where: readonly [number, number], sogKnots: number | null = 0.1, navStatus: number | null = 1): Frame =>
  ({ mmsi, at: seconds, lat: where[1], lon: where[0], sogKnots, cogDeg: null, navStatus });
