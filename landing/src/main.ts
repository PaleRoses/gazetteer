import '@fontsource-variable/jost';
import './styles.css';
import { greatCircle, lattice, type LonLat, type Path, type Points } from './lattice';
import { robotMarkup, shipMarkup } from './sprites';
import { wordField } from './words';

const APP_URL: string = import.meta.env.VITE_APP_URL ?? '/';
const appHref = (path: string): string => `${APP_URL.replace(/\/+$/, '')}${path}` || '/';

const LAND = '#e9e6d6';
const MINT = '#5fe3c0';
const FIELD = '#070808';
const RAD = Math.PI / 180;
const HOME: LonLat = [-34, 17];
const SWAY_DEGREES = 16;
const SWAY_PERIOD = 70;
const INTRO_SECONDS = 1.7;
const IDLE_RETURN_MS = 4500;
const ROUTE_GAP = 5;

const KINGSTON: LonLat = [-76.8, 17.6];
const TANGIER: LonLat = [-6.2, 35.8];

interface Vessel {
  readonly path: Path;
  readonly start: number;
  readonly period: number;
  readonly span: readonly [number, number];
  readonly element: HTMLElement;
  readonly art: HTMLElement;
}

interface Marker {
  readonly at: LonLat;
  readonly element: HTMLElement;
}

interface View {
  yaw: number;
  pitch: number;
  vyaw: number;
  vpitch: number;
  dragging: boolean;
  lastTouch: number;
  lastX: number;
  lastY: number;
  lastMove: number;
}

const HEADLESS = import.meta.env.DEV && new URLSearchParams(window.location.search).has('headless');

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const required = <T extends Element>(selector: string, guard: (node: Element) => node is T): T => {
  const node = document.querySelector(selector);
  if (node && guard(node)) return node;
  throw new TypeError(`landing: ${selector} is missing`);
};

const isCanvas = (node: Element): node is HTMLCanvasElement => node instanceof HTMLCanvasElement;
const isElement = (node: Element): node is HTMLElement => node instanceof HTMLElement;

const canvas = required('#dots', isCanvas);
const layer = required('#layer', isElement);
const globe = required('#globe', isElement);
const robot = required('#robot', isElement);
const context = canvas.getContext('2d', { alpha: true });

document.querySelectorAll<HTMLAnchorElement>('a[data-app]').forEach(anchor => {
  anchor.href = appHref(anchor.dataset['app'] ?? '');
});
robot.innerHTML = robotMarkup();

const sprite = (className: string, inner: string): HTMLElement => {
  const element = document.createElement('div');
  element.className = `sprite ${className}`;
  element.innerHTML = inner;
  layer.append(element);
  return element;
};

const shipSprite = (label: string | null): Readonly<{ element: HTMLElement; art: HTMLElement }> => {
  const element = sprite('ship', `${label ? `<span class="ship-label">${label}</span>` : ''}<span class="ship-bob">${shipMarkup()}</span>`);
  const art = element.querySelector<HTMLElement>('.ship-bob') ?? element;
  return { element, art };
};

const route = greatCircle(KINGSTON, TANGIER, 360);

const vessel = (path: Path, start: number, period: number, span: readonly [number, number], label: string | null): Vessel => ({
  path, start, period, span, ...shipSprite(label),
});

const vessels: readonly Vessel[] = [
  vessel(route, 0.5, 150, [0.06, 0.94], 'Meridian Star'),
  vessel(greatCircle([-31.5, -4.5], [-47, 6.5], 2), 0.35, 420, [0, 1], null),
  vessel(greatCircle([-25, -22], [-2, -31], 2), 0.4, 480, [0, 1], null),
];

const markers: readonly Marker[] = [KINGSTON, TANGIER].map(at => ({ at, element: sprite('port', '<span class="port-square"></span>') }));

const { land, sea } = lattice();

const view: View = {
  yaw: HOME[0], pitch: HOME[1], vyaw: 0, vpitch: 0,
  dragging: false, lastTouch: Number.NEGATIVE_INFINITY, lastX: 0, lastY: 0, lastMove: 0,
};

const size = { css: 0, radius: 0, dpr: 1, scale: 1 };

const resize = (): void => {
  const radius = Math.floor(Math.max(120, Math.min(410, globe.clientWidth / 2)));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const css = radius * 2;
  if (css === size.css && dpr === size.dpr) return;
  Object.assign(size, { css, radius, dpr, scale: radius / 410 });
  canvas.width = Math.round(css * dpr);
  canvas.height = Math.round(css * dpr);
  canvas.style.width = `${css}px`;
  canvas.style.height = `${css}px`;
  render();
};

let dirty = true;
let started = -1;
let lastFrame = 0;

const basis = { cosYaw: 1, sinYaw: 0, cosPitch: 1, sinPitch: 0 };
const projected = { x: 0, y: 0, c: 0 };

const setBasis = (): void => {
  basis.cosYaw = Math.cos(view.yaw * RAD);
  basis.sinYaw = Math.sin(view.yaw * RAD);
  basis.cosPitch = Math.cos(view.pitch * RAD);
  basis.sinPitch = Math.sin(view.pitch * RAD);
};

const project = (cx: number, cy: number, sz: number): void => {
  const u = cx * basis.cosYaw + cy * basis.sinYaw;
  const v = cy * basis.cosYaw - cx * basis.sinYaw;
  projected.x = v;
  projected.y = basis.cosPitch * sz - basis.sinPitch * u;
  projected.c = basis.sinPitch * sz + basis.cosPitch * u;
};

const projectLonLat = ([lon, lat]: LonLat): void => {
  const phi = lat * RAD;
  const lambda = lon * RAD;
  project(Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi));
};

const smooth = (edge0: number, edge1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

const drawLand = (ctx: CanvasRenderingContext2D, points: Points, intro: number): void => {
  const half = size.css / 2;
  const unit = size.dpr;
  const cell = 7 * size.scale;
  ctx.fillStyle = LAND;
  for (let index = 0; index < points.count; index += 1) {
    project(points.cx[index] ?? 0, points.cy[index] ?? 0, points.sz[index] ?? 0);
    const c = projected.c;
    if (c <= 0.02) continue;
    const reveal = intro >= 1 ? 1 : smooth(0, 0.22, intro * 1.45 - Math.hypot(projected.x, projected.y) - (points.jitter[index] ?? 0) * 0.2);
    if (reveal <= 0) continue;
    const side = Math.max(1, Math.round(cell * (0.1 + 0.9 * c) * reveal * unit));
    ctx.globalAlpha = (0.08 + 0.92 * c) * reveal;
    ctx.fillRect(
      Math.round((half + projected.x * size.radius) * unit - side / 2),
      Math.round((half - projected.y * size.radius) * unit - side / 2),
      side, side);
  }
};

const drawLimb = (ctx: CanvasRenderingContext2D, points: Points, intro: number): void => {
  const half = size.css / 2;
  const unit = size.dpr;
  ctx.fillStyle = LAND;
  for (let index = 0; index < points.count; index += 1) {
    project(points.cx[index] ?? 0, points.cy[index] ?? 0, points.sz[index] ?? 0);
    const c = projected.c;
    if (c <= 0.0 || c > 0.32) continue;
    const side = Math.max(1, Math.round(1.6 * size.scale * unit));
    ctx.globalAlpha = 0.42 * (1 - c / 0.32) * smooth(0.5, 1, intro);
    ctx.fillRect(
      Math.round((half + projected.x * size.radius) * unit - side / 2),
      Math.round((half - projected.y * size.radius) * unit - side / 2),
      side, side);
  }
};

const drawRoute = (ctx: CanvasRenderingContext2D, progress: number, phase: number, intro: number): void => {
  const half = size.css / 2;
  const unit = size.dpr;
  const points = route.points;
  const fade = smooth(0.6, 1, intro);
  ctx.fillStyle = MINT;
  for (let index = 0; index < route.count; index += 1) {
    if ((index - phase + ROUTE_GAP * 1000) % ROUTE_GAP !== 0) continue;
    project(points.cx[index] ?? 0, points.cy[index] ?? 0, points.sz[index] ?? 0);
    const c = projected.c;
    if (c <= 0.03) continue;
    const ahead = index / (route.count - 1) >= progress;
    const side = Math.max(1, Math.round(3.2 * size.scale * (0.5 + 0.5 * Math.sqrt(c)) * unit));
    ctx.globalAlpha = (ahead ? 1 : 0.38) * smooth(0.03, 0.25, c) * fade;
    ctx.fillRect(
      Math.round((half + projected.x * size.radius) * unit - side / 2),
      Math.round((half - projected.y * size.radius) * unit - side / 2),
      side, side);
  }
};

const place = (element: HTMLElement, visibility: number): boolean => {
  const half = size.css / 2;
  const x = Math.round(half + projected.x * size.radius);
  const y = Math.round(half - projected.y * size.radius);
  const opacity = visibility.toFixed(2);
  element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  if (element.style.opacity !== opacity) element.style.opacity = opacity;
  const hidden = visibility < 0.01;
  if (element.hidden !== hidden) element.hidden = hidden;
  return !hidden;
};

const voyage = (ship: Vessel, seconds: number): number => {
  const [from, to] = ship.span;
  const cycle = (ship.start + seconds / ship.period) % 1;
  return from + (to - from) * cycle;
};

const ends = (ship: Vessel, t: number): number => {
  const [from, to] = ship.span;
  const margin = (to - from) * 0.05;
  return from === 0 && to === 1 ? 1 : smooth(from, from + margin, t) * (1 - smooth(to - margin, to, t));
};

const placeVessels = (seconds: number, sprites: number): number => vessels.reduce((meridian, ship, index) => {
  const t = voyage(ship, seconds);
  const ahead = ship.path.at(Math.min(1, t + 0.01));
  projectLonLat(ahead);
  const aheadX = projected.x;
  projectLonLat(ship.path.at(t));
  const west = aheadX < projected.x;
  if (ship.art.classList.contains('west') !== west) ship.art.classList.toggle('west', west);
  place(ship.element, smooth(0.06, 0.28, projected.c) * ends(ship, t) * sprites);
  return index === 0 ? t : meridian;
}, 0);

const placeMarkers = (sprites: number): void => markers.forEach(marker => {
  projectLonLat(marker.at);
  place(marker.element, smooth(0.04, 0.22, projected.c) * sprites);
});

const wrapDegrees = (angle: number): number => ((((angle + 180) % 360) + 360) % 360) - 180;

const steer = (seconds: number, dt: number, now: number): void => {
  if (view.dragging) return;
  if (reducedMotion.matches) {
    view.vyaw = 0;
    view.vpitch = 0;
    return;
  }
  const decay = Math.exp(-dt * 2.6);
  view.yaw += view.vyaw * dt;
  view.pitch = Math.max(-55, Math.min(60, view.pitch + view.vpitch * dt));
  view.vyaw *= decay;
  view.vpitch *= decay;
  if (now - view.lastTouch < IDLE_RETURN_MS) return;
  const targetYaw = HOME[0] + SWAY_DEGREES * Math.sin((seconds / SWAY_PERIOD) * 2 * Math.PI);
  const pull = 1 - Math.exp(-dt * (now - view.lastTouch === Number.POSITIVE_INFINITY ? 6 : 0.9));
  view.yaw += wrapDegrees(targetYaw - view.yaw) * pull;
  view.pitch += (HOME[1] - view.pitch) * pull;
};

const clock = { seconds: 0, intro: reducedMotion.matches ? 1 : 0 };

const render = (): void => {
  if (!context) return;
  const still = reducedMotion.matches;
  const sprites = smooth(0.55, 1, clock.intro);
  setBasis();
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.globalAlpha = 0.84 * smooth(0, 0.6, clock.intro);
  context.fillStyle = FIELD;
  context.beginPath();
  context.arc(canvas.width / 2, canvas.height / 2, size.radius * size.dpr, 0, 2 * Math.PI);
  context.fill();
  drawLimb(context, sea, clock.intro);
  drawLand(context, land, clock.intro);
  const progress = placeVessels(clock.seconds, sprites);
  drawRoute(context, progress, still ? 0 : Math.floor(clock.seconds * 7) % ROUTE_GAP, clock.intro);
  placeMarkers(sprites);
  context.globalAlpha = 1;
  dirty = false;
};

const frame = (now: number): void => {
  if (started < 0) started = now;
  const dt = Math.min(0.05, (now - (lastFrame || now)) / 1000);
  lastFrame = now;
  const still = reducedMotion.matches;
  clock.seconds = still ? 0 : (now - started) / 1000;
  clock.intro = still ? 1 : Math.min(1, clock.seconds / INTRO_SECONDS);
  steer(clock.seconds, dt, now);
  if (!still || view.dragging || dirty) render();
  schedule(frame);
};

const schedule: (callback: FrameRequestCallback) => void =
  HEADLESS
    ? callback => { window.setTimeout(() => callback(performance.now()), 16); }
    : callback => { window.requestAnimationFrame(callback); };

const degreesPerPixel = (): number => (1 / (size.radius * RAD)) * 0.9;

canvas.addEventListener('pointerdown', event => {
  canvas.setPointerCapture(event.pointerId);
  Object.assign(view, { dragging: true, vyaw: 0, vpitch: 0, lastX: event.clientX, lastY: event.clientY, lastMove: event.timeStamp, lastTouch: event.timeStamp });
  globe.classList.add('grabbing');
});

canvas.addEventListener('pointermove', event => {
  if (!view.dragging) return;
  const dx = event.clientX - view.lastX;
  const dy = event.clientY - view.lastY;
  const elapsed = Math.max(1, event.timeStamp - view.lastMove) / 1000;
  const k = degreesPerPixel();
  view.yaw -= dx * k;
  view.pitch = Math.max(-55, Math.min(60, view.pitch + dy * k));
  view.vyaw = 0.7 * view.vyaw + 0.3 * (-dx * k / elapsed);
  view.vpitch = 0.7 * view.vpitch + 0.3 * (dy * k / elapsed);
  Object.assign(view, { lastX: event.clientX, lastY: event.clientY, lastMove: event.timeStamp, lastTouch: event.timeStamp });
  dirty = true;
});

const release = (event: PointerEvent): void => {
  if (!view.dragging) return;
  if (event.timeStamp - view.lastMove > 80) Object.assign(view, { vyaw: 0, vpitch: 0 });
  Object.assign(view, { dragging: false, lastTouch: event.timeStamp });
  globe.classList.remove('grabbing');
};

const NUDGE: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-40, 0], ArrowRight: [40, 0], ArrowUp: [0, 30], ArrowDown: [0, -30],
};

canvas.addEventListener('keydown', event => {
  const nudge = NUDGE[event.key];
  if (!nudge) return;
  event.preventDefault();
  const [yaw, pitch] = nudge;
  if (reducedMotion.matches) {
    view.yaw += yaw / 4;
    view.pitch = Math.max(-55, Math.min(60, view.pitch + pitch / 4));
  } else {
    view.vyaw += yaw;
    view.vpitch += pitch;
  }
  view.lastTouch = event.timeStamp;
  dirty = true;
});

canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
window.addEventListener('resize', resize);
reducedMotion.addEventListener('change', () => { dirty = true; });

wordField(required('#words', isCanvas), reducedMotion);
resize();
schedule(frame);
