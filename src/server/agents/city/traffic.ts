/*
 * Traffic risk. The hysteresis idea, and its entry/exit asymmetry, come from Global Fishing Watch pipe-anchorages
 * (Apache License 2.0, github.com/GlobalFishingWatch/pipe-anchorages @ 5761629568b86202ee010388d6a5ae9ce172a21d,
 * transforms/in_out_events.py `_is_in_port`: inside the entry distance is in, beyond the exit distance is out, between keeps the
 * previous answer). The predicate and the 3 km / 4 km pair are reused from ../../telemetry/gfw.ts, which ported them first.
 */
import type { BoardMessage, EtaNotice, PortRisk, ShipObservation, TrafficReport } from '../../../core/board';
import { portById, type PortId } from '../../../core/ports';
import { relaySuccess, type RelayOutcome } from '../../../core/types';
import type { BoardRead, RelayCursor } from '../../relay/board';
import type { RelayIdentity } from '../../relay/client';
import { distanceKm } from '../../sources/geo';
import type { LonLat } from '../../sources/notice';
import { gfwDefaults, isInPort, type GfwParameters } from '../../telemetry/gfw';
import { clip, heartbeat, plural, reportId } from './report';

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
 * GFW measures to an anchorage cluster (3 km in, 4 km out). We measure to the city's reference point, and a container port's
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

export const latestBy = <A>(items: readonly A[], key: (item: A) => string, order: (item: A) => string): readonly A[] =>
  [...items.reduce((latest, item) => {
    const held = latest.get(key(item));
    return held === undefined || order(item) > order(held) ? latest.set(key(item), item) : latest;
  }, new Map<string, A>()).values()];

export type Anchored = Readonly<{ shipmentId: string; observationId: string }>;

/** Ships the board says are stopped outside this city's port: each ship's latest observation, fresh, near it, and within the anchorage with hysteresis. */
export const anchoredShips = (observations: readonly ShipObservation[], city: PortId, at: LonLat, now: Date, previous: readonly string[]): readonly Anchored[] =>
  latestBy(observations, observation => observation.shipmentId, observation => observation.observedAt).flatMap((observation): readonly Anchored[] => {
    const ageHours = (now.getTime() - Date.parse(observation.observedAt)) / 3_600_000;
    return observation.signals.includes('stationary-outside-port') && observation.nearPort === city && ageHours <= anchoredTtlHours
      && isInPort(anchorage, previous.includes(observation.shipmentId), distanceKm(observation.position, at))
      ? [{ shipmentId: observation.shipmentId, observationId: observation.id }] : [];
  });

/** Ships whose latest ETA notice for this city falls within the next 48 hours. */
export const arrivalsDue = (etas: readonly EtaNotice[], city: PortId, now: Date): readonly EtaNotice[] =>
  latestBy(etas.filter(notice => notice.portId === city), notice => notice.shipmentId, notice => notice.at).filter(notice => {
    const hours = (Date.parse(notice.eta) - now.getTime()) / 3_600_000;
    return hours >= 0 && hours <= arrivalWindowHours;
  });

export type TrafficAssessment = Readonly<{
  city: PortId; risk: PortRisk; levels: Levels; anchored: number; arrivals48h: number;
  anchoredShips: readonly string[]; evidenceIds: readonly string[];
}>;

export type TrafficInputs = Readonly<{
  city: PortId; coordinates: LonLat; now: Date;
  observations: readonly ShipObservation[]; etas: readonly EtaNotice[]; previous: Previous | null;
}>;

/**
 * Two signals each grade 0 to 2: ships anchored outside, arrivals due. The traffic risk is the worse of them, and both at elevated
 * or above corroborate each other: that is severe. Pure; `previous` carries the hysteresis state the caller persisted.
 */
export function assessTraffic(input: TrafficInputs): TrafficAssessment {
  const ships = anchoredShips(input.observations, input.city, input.coordinates, input.now, input.previous?.anchoredShips ?? []);
  const due = arrivalsDue(input.etas, input.city, input.now);
  const levels: Levels = {
    anchored: countLevel(bands.anchored, input.previous?.levels.anchored ?? 0, ships.length),
    arrivals: countLevel(bands.arrivals48h, input.previous?.levels.arrivals ?? 0, due.length),
  };
  const level: Level = levels.anchored >= 1 && levels.arrivals >= 1 ? 2 : Math.max(levels.anchored, levels.arrivals) as Level;
  return {
    city: input.city, risk: riskOf(level), levels, anchored: ships.length, arrivals48h: due.length,
    anchoredShips: ships.map(ship => ship.shipmentId),
    evidenceIds: [...ships.map(ship => ship.observationId), ...due.map(notice => notice.id)],
  };
}

const changed = (assessment: TrafficAssessment, previous: TrafficReport | null): boolean =>
  previous === null
    ? assessment.risk !== 'normal' || assessment.anchored > 0 || assessment.arrivals48h > 0
    : previous.risk !== assessment.risk || previous.anchored !== assessment.anchored || previous.arrivals48h !== assessment.arrivals48h;

/** Posts on a change or a heartbeat, and nothing at all for a quiet city that has never said anything. Every number in the summary is a field of the message. */
export const decideTraffic = (assessment: TrafficAssessment, previous: TrafficReport | null, now: Date): TrafficReport | null => {
  if (!changed(assessment, previous) && !heartbeat(previous, assessment.risk, now)) return null;
  const place = portById.get(assessment.city);
  return place ? {
    id: reportId(assessment.city, 'traffic', previous), kind: 'city.traffic', author: { role: 'city', city: assessment.city, element: 'traffic' },
    at: now.toISOString(),
    summary: clip(`${place.name} traffic watch: ${assessment.risk}, ${plural(assessment.anchored, 'ship', 'ships')} anchored outside, ${plural(assessment.arrivals48h, 'arrival', 'arrivals')} due within forty-eight hours.`),
    risk: assessment.risk, anchored: assessment.anchored, arrivals48h: assessment.arrivals48h, evidenceIds: [...assessment.evidenceIds],
    basis: place.serviceRate,
  } : null;
};

/**
 * What a traffic watch remembers of the board between alarms. Bounded by the fleet, not by time: only each ship's latest observation
 * (an observation that moves a ship away must stay to supersede the one before it) and latest ETA for this city are kept.
 */
export type TrafficMemory = Readonly<{
  cursor: RelayCursor; observations: readonly ShipObservation[]; etas: readonly EtaNotice[];
  report: TrafficReport | null; previous: Previous | null;
}>;

export const emptyTrafficMemory: TrafficMemory = { cursor: null, observations: [], etas: [], report: null, previous: null };

export const absorb = (memory: TrafficMemory, messages: readonly BoardMessage[], city: PortId): TrafficMemory => ({
  ...memory,
  observations: latestBy([...memory.observations, ...messages.filter((message): message is ShipObservation => message.kind === 'ship.observation')], item => item.shipmentId, item => item.observedAt),
  etas: latestBy([...memory.etas, ...messages.filter((message): message is EtaNotice => message.kind === 'ship.eta' && message.portId === city)], item => item.shipmentId, item => item.at),
  report: messages.reduce<TrafficReport | null>((latest, message) =>
    message.kind === 'city.traffic' && message.author.city === city && (latest === null || message.at >= latest.at) ? message : latest, memory.report),
});

export type BoardIo = Readonly<{
  read: (identity: RelayIdentity, cursor: RelayCursor) => Promise<RelayOutcome<BoardRead>>;
  post: (identity: RelayIdentity, message: BoardMessage) => Promise<RelayOutcome<string>>;
}>;

export type Watch = Readonly<{ city: PortId; coordinates: LonLat; now: Date }>;

/**
 * One alarm's worth of a traffic watch: read what ships posted since the cursor, assess, and post a report only on a change or a
 * heartbeat. Failures are data: an unreadable board leaves the memory untouched; a failed post keeps the old report, so the next
 * alarm derives the same id and Relay dedupes it.
 */
export async function watchTraffic(io: BoardIo, identity: RelayIdentity, memory: TrafficMemory, watch: Watch): Promise<Readonly<{ memory: TrafficMemory; outcome: RelayOutcome<null>; decided: TrafficReport | null }>> {
  const read = await io.read(identity, memory.cursor);
  if (read.status === 'unavailable') return { memory, outcome: read, decided: null };
  const absorbed = { ...absorb(memory, read.value.messages, watch.city), cursor: read.value.cursor };
  const assessed = assessTraffic({ city: watch.city, coordinates: watch.coordinates, now: watch.now, observations: absorbed.observations, etas: absorbed.etas, previous: absorbed.previous });
  const advanced: TrafficMemory = { ...absorbed, previous: { levels: assessed.levels, anchoredShips: assessed.anchoredShips } };
  const report = decideTraffic(assessed, absorbed.report, watch.now);
  if (report === null) return { memory: advanced, outcome: relaySuccess(null), decided: null };
  const posted = await io.post(identity, report);
  return posted.status === 'unavailable' ? { memory: advanced, outcome: posted, decided: report } : { memory: { ...advanced, report }, outcome: relaySuccess(null), decided: report };
}
