// Regenerates src/client/world-pixels.svg from world-atlas land-110m, which only landing/node_modules carries: the root takes no geodata dependency.
// Run: bun scripts/pixel-world.ts
import { z } from 'zod';

const CELL_DEGREES = 1.5;
const CELL = 10;
const SQUARE = 7;
const NORTH = 84;
const SOUTH = -60;
const COLUMNS = 360 / CELL_DEGREES;
const ROWS = (NORTH - SOUTH) / CELL_DEGREES;
const LAND = '#e9e6d6';

type Point = readonly [number, number];

const pair = z.tuple([z.number(), z.number()]);
const geometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Polygon'), arcs: z.array(z.array(z.number().int())) }),
  z.object({ type: z.literal('MultiPolygon'), arcs: z.array(z.array(z.array(z.number().int()))) }),
]);
const topology = z.object({
  transform: z.object({ scale: pair, translate: pair }),
  arcs: z.array(z.array(pair)),
  objects: z.object({ land: z.object({ geometries: z.array(geometry) }) }),
});

const landingModules = new URL('../landing/node_modules/', import.meta.url);
const source = new URL('world-atlas/land-110m.json', landingModules);
const world = topology.parse(await Bun.file(source).json());
const [sx, sy] = world.transform.scale;
const [tx, ty] = world.transform.translate;

const decode = (arc: readonly (readonly [number, number])[]): readonly Point[] =>
  arc.reduce<{ x: number; y: number; points: Point[] }>((state, [dx, dy]) => {
    const x = state.x + dx;
    const y = state.y + dy;
    return { x, y, points: [...state.points, [x * sx + tx, y * sy + ty]] };
  }, { x: 0, y: 0, points: [] }).points;

const arcPoints = (reference: number): readonly Point[] => reference < 0 ? decode(world.arcs[~reference] ?? []).toReversed() : decode(world.arcs[reference] ?? []);
const ring = (references: readonly number[]): readonly Point[] => references.flatMap((reference, at) => arcPoints(reference).slice(at === 0 ? 0 : 1));
const unwrap = (points: readonly Point[]): readonly Point[] =>
  points.reduce<Point[]>((done, [x, y]) => {
    const previous = done.at(-1);
    const shift = previous === undefined ? 0 : Math.round((previous[0] - x) / 360) * 360;
    return [...done, [x + shift, y]];
  }, []);
const rings = world.objects.land.geometries
  .flatMap(item => item.type === 'Polygon' ? item.arcs : item.arcs.flat())
  .map(references => unwrap(ring(references)))
  .filter(points => points.some(([, y]) => y > SOUTH));
const edges: readonly (readonly [Point, Point])[] = rings.flatMap(points => points.slice(1).map((end, at): readonly [Point, Point] => [points[at] ?? end, end]));

const latitudeOf = (row: number): number => NORTH - (row + 0.5) * CELL_DEGREES;
const longitudeOf = (column: number): number => -180 + (column + 0.5) * CELL_DEGREES;

const crossings = (latitude: number): readonly number[] =>
  edges
    .filter(([[, ay], [, by]]) => (ay > latitude) !== (by > latitude))
    .map(([[ax, ay], [bx, by]]) => ax + (latitude - ay) * (bx - ax) / (by - ay))
    .toSorted((left, right) => left - right);

const landRow = (row: number): readonly boolean[] => {
  const xs = crossings(latitudeOf(row));
  const odd = (longitude: number): boolean => xs.filter(x => x < longitude).length % 2 === 1;
  return Array.from({ length: COLUMNS }, (_, column) => [-360, 0, 360].some(shift => odd(longitudeOf(column) + shift)));
};

const runs = (cells: readonly boolean[]): readonly (readonly [number, number])[] =>
  cells.reduce<{ open: number | undefined; found: (readonly [number, number])[] }>((state, land, column) =>
    land
      ? { open: state.open ?? column, found: state.found }
      : state.open === undefined ? state : { open: undefined, found: [...state.found, [state.open, column - state.open]] },
  { open: undefined, found: [] }).found;

const rows = Array.from({ length: ROWS }, (_, row) => landRow(row));
const runPath = rows.flatMap((cells, row) => runs([...cells, false]).map(([start, length]) => `M${start * CELL} ${row * CELL}h${length * CELL}v${CELL}h-${length * CELL}z`)).join('');

const hash = (n: number): number => {
  const s = Math.sin(n * 12.9898) * 43758.5453;
  return s - Math.floor(s);
};
const landCells = rows.flatMap((cells, row) => cells.flatMap((land, column) => land ? [[column, row] as const] : []));
const twinkles = landCells.filter((_, index) => hash(index + 1) < 14 / landCells.length);
const inset = (CELL - SQUARE) / 2;
const twinkleRects = twinkles.map(([column, row], index) =>
  `<rect class="twinkle" style="animation-delay:${(index * 1.7) % 9}s" x="${column * CELL + inset}" y="${row * CELL + inset}" width="${SQUARE}" height="${SQUARE}"/>`).join('');

const project = (longitude: number, latitude: number): Point => [((longitude + 180) / CELL_DEGREES) * CELL, ((NORTH - latitude) / CELL_DEGREES) * CELL];
const [shipStartX, shipY] = project(-68, 31);
const [shipEndX] = project(-22, 31);
const ship = 'M3 0h1v2H3zM2 2h4v6H2zM7 3h3v2H7zM11 3h3v2h-3zM15 3h3v2h-3zM7 6h3v2H7zM11 6h3v2h-3zM15 6h3v2h-3zM19 6h2v2h-2zM0 8h22v1H0zM1 9h20v1H1zM2 10h17v1H2z';

const width = COLUMNS * CELL;
const height = ROWS * CELL;
const style = [
  `.land{fill:url(#cell)}`,
  `.twinkle{fill:${LAND};opacity:.3;animation:twinkle 9s ease-in-out infinite}`,
  `.ship{fill:${LAND};opacity:.75;animation:sail 60s linear infinite}`,
  `@keyframes twinkle{0%,100%{opacity:.3}50%{opacity:.95}}`,
  `@keyframes sail{0%{transform:translate(${shipStartX}px,${shipY}px);opacity:0}8%,92%{opacity:.75}100%{transform:translate(${shipEndX}px,${shipY}px);opacity:0}}`,
  `@media(prefers-reduced-motion:reduce){.twinkle{animation:none}.ship{animation:none;transform:translate(${(shipStartX + shipEndX) / 2}px,${shipY}px)}}`,
].join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges"><title>World land, ${CELL_DEGREES}° pixels, ${NORTH}°N to ${-SOUTH}°S</title><style>${style}</style><defs><pattern id="cell" width="${CELL}" height="${CELL}" patternUnits="userSpaceOnUse"><rect x="${inset}" y="${inset}" width="${SQUARE}" height="${SQUARE}" fill="${LAND}" fill-opacity=".3"/></pattern></defs><path class="land" d="${runPath}"/>${twinkleRects}<g class="ship" transform="translate(${shipStartX} ${shipY})"><path d="${ship}" transform="scale(2)"/></g></svg>\n`;

await Bun.write(new URL('../src/client/world-pixels.svg', import.meta.url), svg);
console.log(`${landCells.length} land cells, ${twinkles.length} twinkles, ${svg.length} bytes`);
