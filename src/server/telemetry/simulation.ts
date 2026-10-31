import { ports } from '../../domain.js';
import { positionAlong, progressAt, routeLengthKm, voyageRoute } from '../../sea-routes.js';
import type { Shipment } from '../../shared.js';
import type { LonLat, Telemetry, TelemetrySource } from './telemetry';

/**
 * A scripted fleet for the first-run experience. Every value is a pure function of the shipment, its scenario and `now`: a restart
 * reproduces the same vessel, and nothing here ever claims to be live. Provider and provenance are 'simulation'.
 */
export type Scenario =
  | Readonly<{ kind: 'underway' }>
  | Readonly<{ kind: 'slow'; ratio: number }>
  | Readonly<{ kind: 'anchored'; offsetKm: number; bearingDegrees: number }>
  | Readonly<{ kind: 'dark'; silentHours: number }>;

export const underway: Scenario = { kind: 'underway' };

/** The stories: a Singapore queue (two ships at anchor 12 and 18 km out), a slow ship in the Indian Ocean, a ship silent in the mid-Pacific. */
export const demoScenarios: Readonly<Record<string, Scenario>> = {
  'gz-1046': { kind: 'anchored', offsetKm: 12, bearingDegrees: 200 },
  'gz-1047': { kind: 'anchored', offsetKm: 18, bearingDegrees: 160 },
  'gz-1051': { kind: 'slow', ratio: 0.4 },
  'gz-1052': { kind: 'dark', silentHours: 14 },
};

const maxKnots = 25;
const kmPerDegree = 111.195;
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
  const hoursToEta = (Date.parse(shipment.eta) - nowMs) / 3_600_000;
  const impliedKnots = hoursToEta > 0 ? Math.min(maxKnots, routeLengthKm(route) * (1 - fractionAt(nowMs)) / 1.852 / hoursToEta) : 0;
  const along = (ms: number): Readonly<{ position: LonLat; course: number }> => {
    const f = fractionAt(ms);
    const position = positionAlong(route, f) ?? shipment.coordinates;
    const ahead = positionAlong(route, Math.min(1, f + 0.002)) ?? position;
    return { position, course: round1(bearingBetween(position, ahead)) };
  };
  const base = { mmsi: simulationKey(shipment.id), provenance: 'simulation' as const, provider: 'simulation' as const, fetchedAt: now };
  switch (scenario.kind) {
    case 'underway': { const { position, course } = along(nowMs); return { ...base, position, sogKnots: round1(impliedKnots), cogDegrees: course, navStatus: 0, observedAt: now }; }
    case 'slow': { const { position, course } = along(nowMs); return { ...base, position, sogKnots: round1(impliedKnots * scenario.ratio), cogDegrees: course, navStatus: 0, observedAt: now }; }
    case 'anchored': {
      const port = ports.find(item => item.id === shipment.destination);
      return { ...base, position: offsetFrom(port?.coordinates ?? shipment.coordinates, scenario.offsetKm, scenario.bearingDegrees), sogKnots: 0.1, cogDegrees: (scenario.bearingDegrees + 180) % 360, navStatus: 1, observedAt: now };
    }
    case 'dark': { const lastFix = nowMs - scenario.silentHours * 3_600_000; const { position, course } = along(lastFix); return { ...base, position, sogKnots: round1(impliedKnots), cogDegrees: course, navStatus: 0, observedAt: iso(lastFix) }; }
  }
}

export const simulationKey = (shipmentId: string): string => `sim:${shipmentId}`;

/** A telemetry source for one shipment. It needs no network and cannot fail. */
export const simulationSource = (shipment: Shipment, scenarios: Readonly<Record<string, Scenario>> = demoScenarios, clock: () => string = () => new Date().toISOString()): TelemetrySource =>
  async () => ({ status: 'ok', value: simulate(shipment, scenarios[shipment.id] ?? underway, clock()) });

export const demoEnabled = (env: Readonly<Record<string, string | undefined>>): boolean => env.GAZETTEER_DEMO !== 'off';

export type Binding = Readonly<{ key: string; source: TelemetrySource }>;

/** A real MMSI feed always wins; without one the scripted fleet stands in unless the demo is switched off; otherwise the ship is not watched. */
export const telemetryBinding = (shipment: Shipment, mmsi: string | undefined, demo: boolean, real: TelemetrySource, clock?: () => string): Binding | null =>
  mmsi ? { key: mmsi, source: real } : demo ? { key: simulationKey(shipment.id), source: simulationSource(shipment, demoScenarios, clock) } : null;
