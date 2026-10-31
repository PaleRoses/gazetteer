import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import { distanceKm, routeLengthKm, type Route } from '../../sea-routes';
import { navStatusLabels, type LonLat, type Telemetry } from './telemetry';

export type Thresholds = Readonly<{
  offRouteKm: number; slowRatio: number; slowCheckMinRemainingKm: number; minImpliedKnots: number;
  stoppedKnots: number; berthRadiusKm: number; darkAfterMinutes: number;
}>;
/** Declared, not tuned: every signal carries the threshold it crossed. */
export const defaultThresholds: Thresholds = {
  offRouteKm: 50, slowRatio: 0.6, slowCheckMinRemainingKm: 300, minImpliedKnots: 5, stoppedKnots: 0.5, berthRadiusKm: 5, darkAfterMinutes: 60,
};

export type KnownPort = Readonly<{ name: string; coordinates: LonLat }>;
export type Plan = Readonly<{ route: Route; eta: string; ports: readonly KnownPort[] }>;
export type SignalKind = 'off-route' | 'slow-steaming' | 'stationary-outside-port' | 'ais-dark';
export type Signal = Readonly<{
  id: string; kind: SignalKind; title: string; detail: string; observedAt: string;
  provenance: 'live'; provider: Telemetry['provider']; fetchedAt: string;
  measured: Readonly<Record<string, number | string | null>>; thresholds: Readonly<Record<string, number>>; telemetry: Telemetry;
}>;
export type Reading = Readonly<{
  ageMinutes: number; offRouteKm: number | null; remainingKm: number | null; hoursToEta: number; impliedKnots: number | null;
  nearestPort: Readonly<{ name: string; km: number }> | null;
}>;
export type Observation = Readonly<{ reading: Reading; signals: readonly Signal[] }>;

const kmPerNauticalMile = 1.852;
const round = (value: number, places = 1): number => Math.round(value * 10 ** places) / 10 ** places;

const onRoute = (route: Route, at: LonLat): Readonly<{ offRouteKm: number; remainingKm: number }> | null => {
  if (route.length < 2) return null;
  const snapped = nearestPointOnLine(lineString(route.map(position => [...position])), point([...at]), { units: 'kilometers' }).properties;
  return { offRouteKm: snapped.pointDistance, remainingKm: Math.max(0, routeLengthKm(route) - snapped.lineDistance) };
};

const nearestPortOf = (ports: readonly KnownPort[], at: LonLat): Reading['nearestPort'] =>
  ports.reduce<Reading['nearestPort']>((best, port) => {
    const km = distanceKm(port.coordinates, at);
    return !best || km < best.km ? { name: port.name, km } : best;
  }, null);

/** Pure: latest telemetry against the plan. A dark transponder suppresses every position-derived signal, since its position is stale. */
export function observe(plan: Plan, telemetry: Telemetry, now: string, thresholds: Thresholds = defaultThresholds): Observation {
  const ageMinutes = Math.max(0, (Date.parse(now) - Date.parse(telemetry.observedAt)) / 60_000);
  const hoursToEta = (Date.parse(plan.eta) - Date.parse(now)) / 3_600_000;
  const progress = onRoute(plan.route, telemetry.position);
  const impliedKnots = progress && hoursToEta > 0 ? progress.remainingKm / kmPerNauticalMile / hoursToEta : null;
  const nearestPort = nearestPortOf(plan.ports, telemetry.position);
  const reading: Reading = { ageMinutes, offRouteKm: progress?.offRouteKm ?? null, remainingKm: progress?.remainingKm ?? null, hoursToEta, impliedKnots, nearestPort };
  const signal = (kind: SignalKind, title: string, detail: string, measured: Signal['measured'], used: Signal['thresholds']): Signal => ({
    id: `${telemetry.mmsi}:${kind}:${telemetry.observedAt}`, kind, title, detail, observedAt: telemetry.observedAt,
    provenance: 'live', provider: telemetry.provider, fetchedAt: telemetry.fetchedAt, measured, thresholds: used, telemetry,
  });
  const status = telemetry.navStatus === null ? 'status unknown' : navStatusLabels[telemetry.navStatus] ?? `status ${telemetry.navStatus}`;

  if (ageMinutes > thresholds.darkAfterMinutes) return { reading, signals: [signal('ais-dark',
    'AIS transponder dark',
    `No position report for ${Math.round(ageMinutes)} minutes (threshold ${thresholds.darkAfterMinutes}); the last known position is stale.`,
    { ageMinutes: round(ageMinutes) }, { darkAfterMinutes: thresholds.darkAfterMinutes })] };

  const offRoute = progress && progress.offRouteKm > thresholds.offRouteKm
    ? [signal('off-route', 'Vessel off the planned route', `${round(progress.offRouteKm)} km from the planned route (threshold ${thresholds.offRouteKm} km).`,
      { offRouteKm: round(progress.offRouteKm) }, { offRouteKm: thresholds.offRouteKm })] : [];

  const stationary = telemetry.sogKnots !== null && telemetry.sogKnots < thresholds.stoppedKnots || telemetry.navStatus === 1;
  const stopped = stationary && nearestPort !== null && nearestPort.km > thresholds.berthRadiusKm
    ? [signal('stationary-outside-port', 'Vessel stopped outside port',
      `${status}, ${telemetry.sogKnots ?? 'unknown'} kn, ${round(nearestPort.km)} km from ${nearestPort.name} (berth radius ${thresholds.berthRadiusKm} km); a possible congestion queue.`,
      { sogKnots: telemetry.sogKnots, navStatus: status, nearestPortKm: round(nearestPort.km) }, { stoppedKnots: thresholds.stoppedKnots, berthRadiusKm: thresholds.berthRadiusKm })] : [];

  const slow = !stationary && telemetry.sogKnots !== null && progress && impliedKnots !== null
    && impliedKnots >= thresholds.minImpliedKnots && progress.remainingKm > thresholds.slowCheckMinRemainingKm
    && telemetry.sogKnots < thresholds.slowRatio * impliedKnots
    ? [signal('slow-steaming', 'Speed below what the ETA needs',
      `${telemetry.sogKnots} kn over ground against ${round(impliedKnots)} kn needed to cover ${Math.round(progress.remainingKm)} km by the ETA (threshold ${Math.round(thresholds.slowRatio * 100)}% of required).`,
      { sogKnots: telemetry.sogKnots, impliedKnots: round(impliedKnots), remainingKm: Math.round(progress.remainingKm) }, { slowRatio: thresholds.slowRatio, minImpliedKnots: thresholds.minImpliedKnots, slowCheckMinRemainingKm: thresholds.slowCheckMinRemainingKm })] : [];

  return { reading, signals: [...offRoute, ...stopped, ...slow] };
}

/** A situation is the set of signal kinds that began together; it is what the assessor is asked about, once. */
export type Situation = Readonly<{ id: string; kinds: readonly SignalKind[]; startedAt: string }>;

/** Pure: keeps the open situation while its kinds persist or shrink; a newly appearing kind opens a new one; no signals closes it. */
export function nextSituation(previous: Situation | null, signals: readonly Signal[], shipmentId: string, now: string): Situation | null {
  const kinds = [...new Set(signals.map(item => item.kind))].sort();
  if (kinds.length === 0) return null;
  if (previous && kinds.every(kind => previous.kinds.includes(kind))) return previous;
  return { id: `telemetry:${shipmentId}:${kinds.join('+')}:${now}`, kinds, startedAt: now };
}
