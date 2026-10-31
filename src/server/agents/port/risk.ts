/*
 * Port risk. The hysteresis idea, and its entry/exit asymmetry, come from Global Fishing Watch pipe-anchorages
 * (Apache License 2.0, github.com/GlobalFishingWatch/pipe-anchorages @ 5761629568b86202ee010388d6a5ae9ce172a21d,
 * transforms/in_out_events.py `_is_in_port`: inside the entry distance is in, beyond the exit distance is out, between keeps the
 * previous answer). The predicate and the 3 km / 4 km pair are reused from ../telemetry/gfw.ts, which ported them first.
 */
import type { EtaNotice, PortRisk, ShipObservation } from '../../../core/board';
import type { PortId } from '../../../core/types';
import { distanceKm } from '../../sources/geo';
import type { PortNotice } from '../../sources/poll';
import type { LonLat, NoticeSeverity } from '../../sources/notice';
import { gfwDefaults, isInPort, type GfwParameters } from '../../telemetry/gfw';

export type Level = 0 | 1 | 2;
export type Levels = Readonly<{ anchored: Level; arrivals: Level }>;
export type Previous = Readonly<{ levels: Levels; anchoredShips: readonly string[] }>;

export const riskOf = (level: Level): PortRisk => (['normal', 'elevated', 'severe'] as const)[level];

type Band = Readonly<{ enter: number; exit: number }>;
type Bands = Readonly<{ elevated: Band; severe: Band }>;

/**
 * Counts are scoped to one workspace's fleet, which is small, so the bands are small. A level is entered at `enter` and kept
 * until the count falls below `exit`, one less: a queue of 2 that drops to 1 is still a queue, so the risk does not flap
 * on every ship that leaves and returns (GFW's asymmetry, in counts instead of kilometres).
 */
export const bands = {
  anchored: { elevated: { enter: 2, exit: 1 }, severe: { enter: 4, exit: 3 } },
  arrivals48h: { elevated: { enter: 3, exit: 2 }, severe: { enter: 5, exit: 4 } },
} as const satisfies Readonly<Record<string, Bands>>;

/**
 * GFW measures to an anchorage cluster (3 km in, 4 km out). We measure to the port's reference point, and a container port's
 * anchorage lies tens of kilometres offshore, so the same 3:4 asymmetry is scaled to 30 km in, 40 km out. The radius is this
 * lane's estimate, not GFW's; the ratio and the predicate are theirs.
 */
export const anchorage: GfwParameters = { ...gfwDefaults, anchorageEntryKm: 30, anchorageExitKm: 40 };

/** One stationary observation is posted once, when the situation starts, and never repeated, so it lapses after a day: twice GFW's 720-minute minimum stationary period. */
export const anchoredTtlHours = 24;
export const arrivalWindowHours = 48;

export const countLevel = (band: Bands, previous: Level, value: number): Level => {
  const entered: Level = value >= band.severe.enter ? 2 : value >= band.elevated.enter ? 1 : 0;
  const kept: Level = previous >= 2 && value >= band.severe.exit ? 2 : previous >= 1 && value >= band.elevated.exit ? 1 : 0;
  return Math.max(entered, kept) as Level;
};

const severityRank: Readonly<Record<NoticeSeverity, number>> = { minor: 0, moderate: 1, severe: 2, extreme: 3 };

/**
 * A live notice's level. Its severity sets the rank (minor 0, moderate 1, severe 2, extreme 3), and one step is taken off when it
 * does not sit squarely on the port: beyond half its declared reach, or only crossing a sea lane. A minor notice never raises the
 * risk, so a routine marine weather statement leaves the port normal.
 */
export const noticeLevel = ({ notice, hit }: PortNotice): Level => {
  const squarely = hit.basis === 'declared-zone' || (hit.basis === 'distance' && hit.distanceKm <= hit.radiusKm / 2);
  return Math.min(2, Math.max(0, severityRank[notice.severity] - (squarely ? 0 : 1))) as Level;
};

export const latestBy = <A>(items: readonly A[], key: (item: A) => string, order: (item: A) => string): readonly A[] =>
  [...items.reduce((latest, item) => {
    const held = latest.get(key(item));
    return held === undefined || order(item) > order(held) ? latest.set(key(item), item) : latest;
  }, new Map<string, A>()).values()];

export type Anchored = Readonly<{ shipmentId: string; observationId: string }>;

/** Ships the board says are stopped outside this port: each ship's latest observation, fresh, near this port, and within the anchorage with hysteresis. */
export const anchoredShips = (observations: readonly ShipObservation[], portId: PortId, at: LonLat, now: Date, previous: readonly string[]): readonly Anchored[] =>
  latestBy(observations, observation => observation.shipmentId, observation => observation.observedAt).flatMap((observation): readonly Anchored[] => {
    const ageHours = (now.getTime() - Date.parse(observation.observedAt)) / 3_600_000;
    return observation.signals.includes('stationary-outside-port') && observation.nearPort === portId && ageHours <= anchoredTtlHours
      && isInPort(anchorage, previous.includes(observation.shipmentId), distanceKm(observation.position, at))
      ? [{ shipmentId: observation.shipmentId, observationId: observation.id }] : [];
  });

/** Ships whose latest ETA notice for this port falls within the next 48 hours. */
export const arrivalsDue = (etas: readonly EtaNotice[], portId: PortId, now: Date): readonly EtaNotice[] =>
  latestBy(etas.filter(notice => notice.portId === portId), notice => notice.shipmentId, notice => notice.at).filter(notice => {
    const hours = (Date.parse(notice.eta) - now.getTime()) / 3_600_000;
    return hours >= 0 && hours <= arrivalWindowHours;
  });

export type PortAssessment = Readonly<{
  portId: PortId; risk: PortRisk; levels: Levels; hazard: Level; anchored: number; arrivals48h: number;
  anchoredShips: readonly string[]; evidenceIds: readonly string[]; reasons: readonly string[];
}>;

export type PortInputs = Readonly<{
  portId: PortId; coordinates: LonLat; now: Date;
  notices: readonly PortNotice[]; observations: readonly ShipObservation[]; etas: readonly EtaNotice[];
  previous: Previous | null;
}>;

/**
 * Three independent signals each grade 0 to 2: live hazard notices, ships anchored outside, arrivals due. The port's risk is the
 * worst of them, and two or more signals at elevated or above corroborate each other: that is severe. Pure; `previous` carries the
 * hysteresis state the caller persisted.
 */
export function assessPort(input: PortInputs): PortAssessment {
  const hazards = input.notices.map(entry => ({ entry, level: noticeLevel(entry) }));
  const hazard = Math.max(0, ...hazards.map(item => item.level)) as Level;
  const ships = anchoredShips(input.observations, input.portId, input.coordinates, input.now, input.previous?.anchoredShips ?? []);
  const due = arrivalsDue(input.etas, input.portId, input.now);
  const levels: Levels = {
    anchored: countLevel(bands.anchored, input.previous?.levels.anchored ?? 0, ships.length),
    arrivals: countLevel(bands.arrivals48h, input.previous?.levels.arrivals ?? 0, due.length),
  };
  const signals = [hazard, levels.anchored, levels.arrivals];
  const worst = Math.max(...signals) as Level;
  const level: Level = signals.filter(value => value >= 1).length >= 2 ? 2 : worst;
  const worstHazard = hazards.filter(item => item.level === hazard && hazard > 0).map(item => item.entry);
  return {
    portId: input.portId, risk: riskOf(level), levels, hazard, anchored: ships.length, arrivals48h: due.length,
    anchoredShips: ships.map(ship => ship.shipmentId),
    evidenceIds: [...worstHazard.map(entry => entry.notice.id), ...ships.map(ship => ship.observationId), ...due.map(notice => notice.id)],
    reasons: [
      ...worstHazard.map(({ notice }) => `${notice.severity} ${notice.kind}: ${notice.title}`),
      ...(ships.length > 0 ? [`${ships.length} ${ships.length === 1 ? 'ship' : 'ships'} stopped outside the port`] : []),
      ...(due.length > 0 ? [`${due.length} ${due.length === 1 ? 'arrival' : 'arrivals'} due within ${arrivalWindowHours} h`] : []),
    ],
  };
}
