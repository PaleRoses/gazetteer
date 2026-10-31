import { portById } from '../../core/ports.js';
import { positionAlong, progressAt, routeLengthKm, voyageRoute } from '../../core/routes.js';
import type { Shipment } from '../../core/types.js';
import type { LonLat, Telemetry, TelemetrySource } from './telemetry';

/**
 * A scripted fleet for the first-run experience. Every value is a pure function of the shipment, its scenario and `now`: a restart
 * reproduces the same vessel, and nothing here ever claims to be live. Provider and provenance are 'simulation'.
 */
export type Scenario =
  | Readonly<{ kind: 'underway' }>
  | Readonly<{ kind: 'slow'; ratio: number }>
  | Readonly<{ kind: 'queue'; offsetKm: number; bearingDegrees: number; holdHours: number }>
  | Readonly<{ kind: 'diversion' }>
  | Readonly<{ kind: 'dark'; silentHours: number }>;

export const underway: Scenario = { kind: 'underway' };

/**
 * The stories, keyed to each ship's own baseline ETA so no clock state exists: a Singapore queue that builds over the first two
 * hours (five arrivals going to anchor); a Red Sea diversion (three ships on the Cape lane
 * against a Suez plan); a slow ship in the Indian Ocean; a ship silent in the mid-Pacific.
 */
export const demoScenarios: Readonly<Record<string, Scenario>> = {
  'gz-1046': { kind: 'queue', offsetKm: 12, bearingDegrees: 200, holdHours: 30 },
  'gz-1047': { kind: 'queue', offsetKm: 18, bearingDegrees: 160, holdHours: 30 },
  'gz-1065': { kind: 'queue', offsetKm: 15, bearingDegrees: 230, holdHours: 30 },
  'gz-1067': { kind: 'queue', offsetKm: 21, bearingDegrees: 140, holdHours: 30 },
  'gz-1073': { kind: 'queue', offsetKm: 24, bearingDegrees: 180, holdHours: 30 },
  'gz-1055': { kind: 'diversion' },
  'gz-1057': { kind: 'diversion' },
  'gz-1058': { kind: 'diversion' },
  'gz-1051': { kind: 'slow', ratio: 0.4 },
  'gz-1052': { kind: 'dark', silentHours: 14 },
};

const maxKnots = 25;
const kmPerDegree = 111.195;
const kmPerNauticalMile = 1.852;
const hourMs = 3_600_000;
const historyHours = 24;
const rad = (degrees: number): number => degrees * Math.PI / 180;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const iso = (ms: number): string => new Date(ms).toISOString();

const offsetFrom = ([lon, lat]: LonLat, km: number, bearingDegrees: number): LonLat =>
  [lon + Math.sin(rad(bearingDegrees)) * km / (kmPerDegree * Math.cos(rad(lat))), lat + Math.cos(rad(bearingDegrees)) * km / kmPerDegree];

const bearingBetween = ([lon1, lat1]: LonLat, [lon2, lat2]: LonLat): number => {
  const dLon = rad(((lon2 - lon1 + 540) % 360) - 180);
  const y = Math.sin(dLon) * Math.cos(rad(lat2));
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
};

/** Pure: where the scenario puts the vessel at `now`. Underway ships hold the speed their ETA implies. */
export function simulate(shipment: Shipment, scenario: Scenario, now: string): Telemetry {
  const route = voyageRoute(shipment) ?? shipment.route;
  const departedAt = shipment.milestones[0]?.at ?? shipment.baselineEta;
  const nowMs = Date.parse(now);
  const fractionAt = (ms: number): number => progressAt(departedAt, shipment.eta, ms);
  const hoursToEta = (Date.parse(shipment.eta) - nowMs) / hourMs;
  const impliedKnots = hoursToEta > 0 ? Math.min(maxKnots, routeLengthKm(route) * (1 - fractionAt(nowMs)) / kmPerNauticalMile / hoursToEta) : 0;
  const pointing = (line: typeof route, f: number): Readonly<{ position: LonLat; course: number }> => {
    const position = positionAlong(line, f) ?? shipment.coordinates;
    const ahead = positionAlong(line, Math.min(1, f + 0.002)) ?? position;
    return { position, course: round1(bearingBetween(position, ahead)) };
  };
  const along = (ms: number) => pointing(route, fractionAt(ms));
  const base = { mmsi: simulationKey(shipment.id), provenance: 'simulation' as const, provider: 'simulation' as const, fetchedAt: now };
  const sailing = (knots: number, at = along(nowMs)): Telemetry => ({ ...base, position: at.position, sogKnots: round1(knots), cogDegrees: at.course, navStatus: 0, observedAt: now });
  switch (scenario.kind) {
    case 'underway': return sailing(impliedKnots);
    case 'slow': return sailing(impliedKnots * scenario.ratio);
    case 'queue': {
      const anchorMs = Date.parse(shipment.baselineEta);
      const port = portById.get(shipment.destination)?.coordinates ?? shipment.coordinates;
      if (nowMs < anchorMs) return sailing(impliedKnots);
      if (nowMs < anchorMs + scenario.holdHours * hourMs) return { ...base, position: offsetFrom(port, scenario.offsetKm, scenario.bearingDegrees), sogKnots: 0.1, cogDegrees: (scenario.bearingDegrees + 180) % 360, navStatus: 1, observedAt: now };
      return { ...base, position: port, sogKnots: 0, cogDegrees: null, navStatus: 5, observedAt: now };
    }
    case 'diversion': {
      const cape = voyageRoute(shipment, 'cape') ?? route;
      const serviceKnots = routeLengthKm(route) / kmPerNauticalMile / Math.max(1, (Date.parse(shipment.baselineEta) - Date.parse(departedAt)) / hourMs);
      const sailedKm = serviceKnots * kmPerNauticalMile * Math.max(0, (nowMs - Date.parse(departedAt)) / hourMs);
      return sailing(serviceKnots, pointing(cape, sailedKm / Math.max(1, routeLengthKm(cape))));
    }
    case 'dark': { const lastFix = nowMs - scenario.silentHours * hourMs; const { position, course } = along(lastFix); return { ...base, position, sogKnots: round1(impliedKnots), cogDegrees: course, navStatus: 0, observedAt: iso(lastFix) }; }
  }
}

/** The last day of hourly fixes, oldest first, from the same pure function: a ship 15 h at anchor shows its loiter on its first alarm. */
const simulatedHistory = (shipment: Shipment, scenario: Scenario, now: string): readonly Telemetry[] =>
  Array.from({ length: historyHours }, (_, index) => simulate(shipment, scenario, iso(Date.parse(now) - (historyHours - index) * hourMs)));

const simulationKey = (shipmentId: string): string => `sim:${shipmentId}`;

/** A telemetry source for one shipment. It needs no network and cannot fail. */
export const simulationSource = (shipment: Shipment, scenarios: Readonly<Record<string, Scenario>> = demoScenarios, clock: () => string = () => new Date().toISOString()): TelemetrySource =>
  async () => {
    const now = clock();
    const scenario = scenarios[shipment.id] ?? underway;
    return { status: 'ok', value: simulate(shipment, scenario, now), history: simulatedHistory(shipment, scenario, now) };
  };

export const demoEnabled = (env: Readonly<Record<string, string | undefined>>): boolean => env.GAZETTEER_DEMO !== 'off';

export type Binding = Readonly<{ key: string; source: TelemetrySource }>;

/** A real MMSI feed always wins; without one the scripted fleet stands in unless the demo is switched off; otherwise the ship is not watched. */
export const telemetryBinding = (shipment: Shipment, mmsi: string | undefined, demo: boolean, real: TelemetrySource, clock?: () => string): Binding | null =>
  mmsi ? { key: mmsi, source: real } : demo ? { key: simulationKey(shipment.id), source: simulationSource(shipment, demoScenarios, clock) } : null;
