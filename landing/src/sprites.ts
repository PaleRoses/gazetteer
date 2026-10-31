type Art = readonly string[];

const runsOf = (row: string): readonly (readonly [number, number])[] =>
  [...row.matchAll(/#+/g)].map(match => [match.index, match[0].length] as const);

const rects = (art: Art, cell: number, attributes = ''): string =>
  art
    .flatMap((row, y) => runsOf(row).map(([x, width]) =>
      `<rect x="${x * cell}" y="${y * cell}" width="${width * cell}" height="${cell}"${attributes}/>`))
    .join('');

const svg = (art: Art, cell: number, body: string, className: string): string => {
  const width = Math.max(...art.map(row => row.length)) * cell;
  const height = art.length * cell;
  return `<svg class="${className}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" fill="currentColor">${body}</svg>`;
};

const SHIP: Art = [
  '...##...........',
  '...##...........',
  '..####..........',
  '..####.###.###..',
  '..####.###.###.#',
  '################',
  '.##############.',
  '..############..',
];

const SHIP_WINDOWS: Art = [
  '................',
  '................',
  '................',
  '...##...........',
];

const SHIP_WAKE: Art = [
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '................',
  '#.#.............',
];

const SHIP_CELL = 2;

export const shipMarkup = (): string =>
  svg(SHIP, SHIP_CELL,
    rects(SHIP, SHIP_CELL)
      + rects(SHIP_WINDOWS, SHIP_CELL, ' class="window"')
      + `<g class="wake">${rects(SHIP_WAKE, SHIP_CELL)}</g>`,
    'ship-art');

const ROBOT_PIP: Art = ['.....##.....'];
const ROBOT_STALK: Art = ['', '.....##.....'];
const ROBOT_HEAD: Art = [
  '',
  '',
  '..########..',
  '..########..',
  '..########..',
  '..########..',
  '..##....##..',
  '..########..',
];
const ROBOT_EYES: Art = ['', '', '', '', '....#..#....'];
const ROBOT_BODY: Art = [
  '', '', '', '', '', '', '', '',
  '....####....',
  '#.########.#',
  '#.########.#',
  '..########..',
  '...##..##...',
  '...##..##...',
];

const ROBOT_CELL = 3;

export const robotMarkup = (): string =>
  svg(ROBOT_BODY, ROBOT_CELL,
    `<g class="robot-body">${rects(ROBOT_BODY, ROBOT_CELL)}</g>`
      + `<g class="robot-head">${rects(ROBOT_STALK, ROBOT_CELL)}<g class="robot-pip">${rects(ROBOT_PIP, ROBOT_CELL)}</g>`
      + rects(ROBOT_HEAD, ROBOT_CELL)
      + `<g class="robot-eyes">${rects(ROBOT_EYES, ROBOT_CELL)}</g></g>`,
    'robot-art');
