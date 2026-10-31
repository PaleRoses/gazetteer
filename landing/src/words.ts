const PORTS = ['Rotterdam', 'Singapore', 'Hamburg', 'Busan', 'Shanghai', 'Antwerp', 'Valencia', 'Algeciras', 'Tanger Med', 'Santos', 'Kingston', 'Felixstowe', 'Piraeus', 'Jebel Ali', 'Colombo', 'Yokohama', 'Savannah', 'Durban', 'Manzanillo', 'Le Havre'];
const STARS = ['Aldebaran', 'Miaplacidus', 'Canopus', 'Meridian Star', 'Achernar', 'Vega', 'Arcturus', 'Capella', 'Rigel', 'Altair', 'Deneb', 'Polaris', 'Spica', 'Sirius', 'Mirfak', 'Hadar'];
const STATUS = ['DELAYED', 'ON TRACK', 'ETA', 'WATCH', 'HOLD', 'CONFIRMED', 'BERTH', 'QUEUE', 'SWELL', 'DRAFT', 'ANCHORED', 'UNDERWAY'];
const VOCABULARY: readonly string[] = [...PORTS, ...STARS, ...STATUS];
const GLYPHS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/·-';

const BONE = '232, 230, 223';
const LIT: readonly string[] = ['240, 90, 69', '245, 181, 61', '95, 227, 192'];

const CELL_WIDTH = 132;
const CELL_HEIGHT = 26;
const STEP_MS = 55;
const LIT_MS = 3200;

interface Cell {
  x: number;
  y: number;
  text: string;
  target: string;
  revealed: number;
  next: number;
  tint: number;
  litAt: number;
  base: number;
}

const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)] ?? (items[0] as T);
const glyph = (): string => GLYPHS[Math.floor(Math.random() * GLYPHS.length)] ?? '·';

const scrambled = (cell: Cell): string =>
  Array.from({ length: Math.max(cell.target.length, cell.text.length) }, (_, index) =>
    index < cell.revealed ? (cell.target[index] ?? '') : (cell.target[index] === ' ' ? ' ' : glyph())).join('');

export const wordField = (canvas: HTMLCanvasElement, reducedMotion: MediaQueryList): void => {
  const context = canvas.getContext('2d');
  if (!context) return;
  let cells: Cell[] = [];
  let width = 0;
  let height = 0;
  let dpr = 1;
  let lastStep = 0;
  let lastWake = 0;

  const layout = (): void => {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const columns = Math.ceil(width / CELL_WIDTH) + 1;
    const rows = Math.ceil(height / CELL_HEIGHT) + 1;
    cells = Array.from({ length: columns * rows }, (_, index): Cell => {
      const row = Math.floor(index / columns);
      const column = index % columns;
      const text = pick(VOCABULARY);
      return {
        x: column * CELL_WIDTH + (row % 2) * (CELL_WIDTH / 2) - 40 + Math.random() * 18,
        y: row * CELL_HEIGHT + 18,
        text, target: text, revealed: text.length, next: 0, tint: -1, litAt: 0,
        base: 0.07 + Math.random() * 0.05,
      };
    });
    draw(performance.now());
  };

  const draw = (now: number): void => {
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    context.font = '500 12px "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';
    context.textBaseline = 'alphabetic';
    cells.forEach(cell => {
      const lit = cell.tint >= 0 ? Math.max(0, 1 - (now - cell.litAt) / LIT_MS) : 0;
      const scrambling = cell.revealed < cell.target.length;
      context.fillStyle = lit > 0
        ? `rgba(${LIT[cell.tint] ?? BONE}, ${(cell.base + 0.5 * lit).toFixed(3)})`
        : `rgba(${BONE}, ${(scrambling ? cell.base + 0.06 : cell.base).toFixed(3)})`;
      context.fillText(cell.text, cell.x, cell.y);
    });
  };

  const wake = (now: number): void => {
    const count = 2 + Math.floor(Math.random() * 3);
    Array.from({ length: count }, () => pick(cells)).forEach(cell => {
      if (cell.revealed < cell.target.length) return;
      cell.target = pick(VOCABULARY.filter(word => word !== cell.text));
      cell.revealed = 0;
      cell.next = now;
    });
  };

  const step = (now: number): void => {
    cells.forEach(cell => {
      if (cell.revealed >= cell.target.length || now < cell.next) return;
      cell.revealed += 1;
      cell.next = now + STEP_MS;
      cell.text = cell.revealed >= cell.target.length ? cell.target : scrambled(cell);
      if (cell.revealed >= cell.target.length && Math.random() < 0.22) {
        cell.tint = Math.floor(Math.random() * LIT.length);
        cell.litAt = now;
      }
    });
  };

  const frame = (now: number): void => {
    if (!reducedMotion.matches) {
      if (now - lastWake > 260) { wake(now); lastWake = now; }
      if (now - lastStep > 40) { step(now); draw(now); lastStep = now; }
    }
    schedule(frame);
  };

  const schedule = (callback: FrameRequestCallback): void => {
    if (import.meta.env.DEV && new URLSearchParams(window.location.search).has('headless')) window.setTimeout(() => callback(performance.now()), 16);
    else window.requestAnimationFrame(callback);
  };

  window.addEventListener('resize', layout);
  layout();
  schedule(frame);
};
