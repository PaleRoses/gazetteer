import type { BoardMessage, ShipObservation } from '../../../core/board';
import { portById, type PortId } from '../../../core/ports';
import { shiftEta } from '../../../core/eta';
import type { AssessedShipment } from '../../assessment/apply';
import { inHorizon, portReportOf, type PortReport } from './board';
import { remainingCalls } from '../../../core/port-calls';
import type { ReactionSummary } from './risk-floor';

/** Declared, not tuned. The queue-drain delay is the queue ahead divided by the port's service rate; the band and cap say how far that estimate may be trusted. */
export const queueDrain = {
  low: { factor: 0.5, basis: 'twice the service rate: berths freeing faster than the port-wide average' },
  high: { factor: 1.5, basis: 'a third slower than the average: weather or yard congestion' },
  capHours: { value: 72, basis: 'beyond three days the carrier would reroute or omit the call, which this rule cannot predict' },
  etaWindowHours: { value: 48, basis: 'the same 48 h the port counts arrivals over: a call further out is not yet in the queue' },
} as const;

export type Reaction = Readonly<{ bulletinId: string; hours: number }>;
export type Reactions = Readonly<Partial<Record<PortId, Reaction>>>;

export type ReactionBasis = Readonly<{
  rule: 'queue-drain'; portId: PortId; bulletinId: string; anchored: number;
  serviceRate: Readonly<{ departuresPerHour: number; provenance: 'assumed' | 'measured' }>;
  hours: Readonly<{ low: number; likely: number; high: number }>;
}>;

export type Reacted<S extends AssessedShipment> = Readonly<{
  shipment: S; reactions: Reactions; summary: ReactionSummary;
  /** Every report heard from a port still ahead, newest per watch, whatever it said. */
  heard: readonly string[];
  /** One entry per port whose estimate this cycle changed. */
  changed: readonly ReactionBasis[];
}>;

const hoursUntil = (at: string, now: string): number => (Date.parse(at) - Date.parse(now)) / 3_600_000;

/** The newest report of each watcher of each port still ahead, inside the horizon. */
const newestBulletins = (board: readonly BoardMessage[], ahead: ReadonlySet<PortId>, now: string): readonly PortReport[] => {
  const newest = new Map<string, PortReport>();
  board.flatMap(message => portReportOf(message) ?? []).filter(report => ahead.has(report.portId) && inHorizon(report.at, now)).forEach(report => {
    const key = `${report.portId}:${report.element}`;
    const known = newest.get(key);
    if (!known || Date.parse(report.at) > Date.parse(known.at) || (report.at === known.at && report.id > known.id)) newest.set(key, report);
  });
  return [...newest.values()];
};

const round = (value: number): number => Math.round(value);

const loitered = (observation: ShipObservation): number => {
  const hours = observation.measured?.loiteringHours;
  return typeof hours === 'number' ? hours : 0;
};
/** Is `other` further back in the queue than `mine`? The longer a ship has loitered the nearer the head; ties go to the earlier report. */
const behindOf = (mine: ShipObservation, other: ShipObservation): boolean =>
  loitered(other) !== loitered(mine) ? loitered(other) < loitered(mine) : other.at !== mine.at ? other.at > mine.at : other.id > mine.id;

/** Ships queued before this one: the report's count, less this ship if the report counted it, less every counted ship the board shows further back in the queue. A stop the ship cannot find on its board counts as ahead of it. */
const anchoredAhead = (bulletin: PortReport, board: readonly BoardMessage[], ownObservation: string | null): number => {
  const mine = ownObservation ? board.find((message): message is ShipObservation => message.id === ownObservation && message.kind === 'ship.observation') : undefined;
  if (!mine) return Math.max(0, bulletin.anchored - (ownObservation && bulletin.evidenceIds.includes(ownObservation) ? 1 : 0));
  const behind = bulletin.evidenceIds.filter(id => id !== mine.id).filter(id => {
    const other = board.find((message): message is ShipObservation => message.id === id && message.kind === 'ship.observation');
    return other !== undefined && behindOf(mine, other);
  }).length;
  return Math.max(0, bulletin.anchored - (bulletin.evidenceIds.includes(mine.id) ? 1 : 0) - behind);
};

/** Pure: what a ship concludes from the newest bulletin of every port it has yet to call at. An elevated or severe port is a watch. The ETA moves only when the bulletin carries a delay basis, ships anchored ahead of this one, and this ship reaches the port inside the window; the delay is set per port, not added, so a repeat bulletin changes nothing and a shorter queue relaxes the estimate. */
export function react<S extends AssessedShipment>(shipment: S, board: readonly BoardMessage[], previous: Reactions, ownObservation: string | null, now: string): Reacted<S> {
  const calls = remainingCalls(shipment);
  const bulletins = newestBulletins(board, new Set(calls.map(call => call.portId)), now);
  const settled = bulletins.reduce<Readonly<{ shipment: S; reactions: Reactions; changed: readonly ReactionBasis[] }>>((state, bulletin) => {
    const known = state.reactions[bulletin.portId];
    const call = calls.find(item => item.portId === bulletin.portId);
    if (bulletin.element === 'hazards' || known?.bulletinId === bulletin.id || !call) return state;
    const port = portById.get(bulletin.portId);
    const ahead = anchoredAhead(bulletin, board, ownObservation);
    const rate = port?.serviceRate;
    const within = hoursUntil(call.eta, now) <= queueDrain.etaWindowHours.value;
    const likely = rate && ahead > 0 && within ? round(Math.min(queueDrain.capHours.value, ahead / rate.perHour)) : 0;
    const hours = { low: round(likely * queueDrain.low.factor), likely, high: round(Math.min(queueDrain.capHours.value, likely * queueDrain.high.factor)) };
    const before = known?.hours ?? 0;
    const basis: ReactionBasis | null = rate && (likely !== before) ? { rule: 'queue-drain', portId: bulletin.portId, bulletinId: bulletin.id, anchored: ahead, serviceRate: { departuresPerHour: rate.perHour, provenance: rate.provenance }, hours } : null;
    return {
      shipment: shiftEta(state.shipment, likely - before),
      reactions: { ...state.reactions, [bulletin.portId]: { bulletinId: bulletin.id, hours: likely } },
      changed: basis ? [...state.changed, basis] : state.changed,
    };
  }, { shipment, reactions: previous, changed: [] });
  const watching = bulletins.filter(bulletin => bulletin.risk !== 'normal').map(bulletin => bulletin.id);
  const total = Object.values(settled.reactions).reduce((sum, reaction) => sum + (reaction?.hours ?? 0), 0);
  const delaying = Object.values(settled.reactions).filter(reaction => reaction && reaction.hours > 0).map(reaction => reaction!.bulletinId);
  return {
    shipment: settled.shipment, reactions: settled.reactions, summary: { watching: [...new Set([...watching, ...delaying])], hours: total },
    changed: settled.changed, heard: bulletins.map(bulletin => bulletin.id),
  };
}
