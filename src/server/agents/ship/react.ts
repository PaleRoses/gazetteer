import type { BoardMessage, PortBulletin } from '../../../core/board';
import { portById, type PortId } from '../../../core/ports';
import { shiftEta } from '../../../core/eta';
import type { AssessedShipment } from '../../assessment/apply';
import { inHorizon, remainingCalls } from './board';
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
  /** One entry per port whose estimate this cycle changed. */
  changed: readonly ReactionBasis[];
}>;

const hoursUntil = (at: string, now: string): number => (Date.parse(at) - Date.parse(now)) / 3_600_000;

/** The newest bulletin for each port still ahead, inside the horizon. */
const newestBulletins = (board: readonly BoardMessage[], ahead: ReadonlySet<PortId>, now: string): readonly PortBulletin[] => {
  const bulletins = board.flatMap(message => message.kind === 'port.bulletin' && ahead.has(message.portId) && inHorizon(message.at, now) ? [message] : []);
  const newest = new Map<PortId, PortBulletin>();
  bulletins.forEach(message => {
    const known = newest.get(message.portId);
    if (!known || Date.parse(message.at) > Date.parse(known.at) || (message.at === known.at && message.id > known.id)) newest.set(message.portId, message);
  });
  return [...newest.values()];
};

const round = (value: number): number => Math.round(value);

/** Ships queued before this one: the bulletin's count, less this ship, less every ship whose stop the board shows was reported after this ship's own. A stop the ship cannot find on its board counts as ahead of it. */
const anchoredAhead = (bulletin: PortBulletin, board: readonly BoardMessage[], ownObservation: string | null): number => {
  const mine = ownObservation && bulletin.evidenceIds.includes(ownObservation) ? board.find(message => message.id === ownObservation) : undefined;
  if (!ownObservation || !bulletin.evidenceIds.includes(ownObservation)) return bulletin.anchored;
  const behind = mine ? bulletin.evidenceIds.filter(id => id !== ownObservation).filter(id => {
    const other = board.find(message => message.id === id);
    return other?.kind === 'ship.observation' && (other.at > mine.at || (other.at === mine.at && other.id > mine.id));
  }).length : 0;
  return Math.max(0, bulletin.anchored - 1 - behind);
};

/** Pure: what a ship concludes from the newest bulletin of every port it has yet to call at. An elevated or severe port is a watch. The ETA moves only when the bulletin carries a delay basis, ships anchored ahead of this one, and this ship reaches the port inside the window; the delay is set per port, not added, so a repeat bulletin changes nothing and a shorter queue relaxes the estimate. */
export function react<S extends AssessedShipment>(shipment: S, board: readonly BoardMessage[], previous: Reactions, ownObservation: string | null, now: string): Reacted<S> {
  const calls = remainingCalls(shipment);
  const bulletins = newestBulletins(board, new Set(calls.map(call => call.portId)), now);
  const settled = bulletins.reduce<Readonly<{ shipment: S; reactions: Reactions; changed: readonly ReactionBasis[] }>>((state, bulletin) => {
    const known = state.reactions[bulletin.portId];
    const call = calls.find(item => item.portId === bulletin.portId);
    if (known?.bulletinId === bulletin.id || !call) return state;
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
    changed: settled.changed,
  };
}
