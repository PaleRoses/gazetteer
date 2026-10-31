import { geoEquirectangular, geoInterpolate, geoPath } from 'd3-geo';
import { feature } from 'topojson-client';
import land from 'world-atlas/land-110m.json';

export type LonLat = readonly [number, number];

export interface Points {
  readonly count: number;
  readonly cx: Float32Array;
  readonly cy: Float32Array;
  readonly sz: Float32Array;
  readonly jitter: Float32Array;
}

const RAD = Math.PI / 180;
const MASK_WIDTH = 1440;
const MASK_HEIGHT = 720;

const landMask = (): Uint8ClampedArray => {
  const canvas = document.createElement('canvas');
  canvas.width = MASK_WIDTH;
  canvas.height = MASK_HEIGHT;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return new Uint8ClampedArray(MASK_WIDTH * MASK_HEIGHT * 4);
  const projection = geoEquirectangular()
    .scale(MASK_WIDTH / (2 * Math.PI))
    .translate([MASK_WIDTH / 2, MASK_HEIGHT / 2])
    .precision(0.1);
  context.beginPath();
  geoPath(projection, context)(feature(land, land.objects.land));
  context.fillStyle = '#fff';
  context.fill();
  return context.getImageData(0, 0, MASK_WIDTH, MASK_HEIGHT).data;
};

const hash = (n: number): number => {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};

const toPoints = (coordinates: readonly LonLat[]): Points => {
  const count = coordinates.length;
  const points = {
    count,
    cx: new Float32Array(count),
    cy: new Float32Array(count),
    sz: new Float32Array(count),
    jitter: new Float32Array(count),
  };
  coordinates.forEach(([lon, lat], index) => {
    const phi = lat * RAD;
    const lambda = lon * RAD;
    points.cx[index] = Math.cos(phi) * Math.cos(lambda);
    points.cy[index] = Math.cos(phi) * Math.sin(lambda);
    points.sz[index] = Math.sin(phi);
    points.jitter[index] = hash(index + 1);
  });
  return points;
};

const STEP = 10 / 410;

export const lattice = (): Readonly<{ land: Points; sea: Points }> => {
  const mask = landMask();
  const isLand = ([lon, lat]: LonLat): boolean => {
    const x = Math.min(MASK_WIDTH - 1, Math.floor(((lon + 180) / 360) * MASK_WIDTH));
    const y = Math.min(MASK_HEIGHT - 1, Math.floor(((90 - lat) / 180) * MASK_HEIGHT));
    return (mask[(y * MASK_WIDTH + x) * 4 + 3] ?? 0) > 127;
  };
  const rows = Math.floor(Math.PI / STEP);
  const grid: readonly LonLat[] = Array.from({ length: rows }, (_, row) => -90 + (row + 0.5) * (180 / rows))
    .flatMap(lat => {
      const columns = Math.max(1, Math.round((2 * Math.PI * Math.cos(lat * RAD)) / STEP));
      return Array.from({ length: columns }, (_, column): LonLat => [-180 + (column + 0.5) * (360 / columns), lat]);
    });
  return {
    land: toPoints(grid.filter(isLand)),
    sea: toPoints(grid.filter((point, index) => !isLand(point) && hash(index * 7.31) < 0.22)),
  };
};

export interface Path {
  readonly count: number;
  readonly points: Points;
  readonly at: (t: number) => LonLat;
}

export const greatCircle = (from: LonLat, to: LonLat, samples: number): Path => {
  const at = geoInterpolate([from[0], from[1]], [to[0], to[1]]);
  const coordinates = Array.from({ length: samples }, (_, index): LonLat => {
    const [lon, lat] = at(index / (samples - 1));
    return [lon, lat];
  });
  return {
    count: samples,
    points: toPoints(coordinates),
    at: t => {
      const [lon, lat] = at(t);
      return [lon, lat];
    },
  };
};
