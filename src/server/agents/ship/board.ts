import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import type { BoardMessage, PortRisk, QueueDrainBasis, ShipAssessment, ShipObservation } from '../../../core/board';
import { ports, type PortId } from '../../../core/ports';
import { distanceKm, voyageRoute } from '../../../core/routes';
import type { RelayOutcome, Risk } from '../../../core/types';
import type { AssessedShipment } from '../../assessment/apply';
import type { BoardEvidence } from '../../assessment/prompt';
import { describeError, type LonLat } from '../../telemetry/telemetry';
import type { Situation } from '../../telemetry/watcher';
import type { RiskFloor } from './risk-floor';
import { assessedSummary, etaSummary, observationSummary, ruleAssessmentSummary } from './voice';

/** A ship counts a port as "near" when it is inside the approach zone where a queue forms. Declared, not tuned. */
export const approachKm = 150;
/** A peer's observation is route evidence when it lies this close to this ship's route and is not older than the horizon. */
export const peerRouteKm = 100;
export const peerHorizonHours = 24;
const maxBulletins = 4;
const maxPeers = 5;

export type ShipBoardMemory = Readonly<{ observed: string | null; assessed: Readonly<{ risk: Risk; eta: string }> | null; etas: Readonly<Record<string, string>> }>;
export const emptyBoardMemory: ShipBoardMemory = { observed: null, assessed: null, etas: {} };

/** A message to post and what the ship may remember once the post is acknowledged. A failed post leaves the memory alone, so the next alarm decides the same thing again with the same id. */
export type Outbound = Readonly<{ message: BoardMessage; remember: (memory: ShipBoardMemory) => ShipBoardMemory }>;

const afterHours = (at: string, hours: number): string => new Date(Date.parse(at) + hours * 3_600_000).toISOString();

const nearestPortId = (position: LonLat): PortId | null =>
  ports.reduce<Readonly<{ id: PortId | null; km: number }>>((best, port) => {
    const km = distanceKm(port.coordinates, position);
    return km <= approachKm && km < best.km ? { id: port.id, km } : best;
  }, { id: null, km: Infinity }).id;

const viaMilestone = (shipment: AssessedShipment) => shipment.milestones.find(milestone => milestone.label === 'Transshipment berth');

/** Ports still ahead, each with this ship's ETA there: via ports read their transshipment milestone, the destination the shipment ETA. */
export function remainingCalls(shipment: AssessedShipment): readonly Readonly<{ portId: PortId; eta: string }>[] {
  const via = viaMilestone(shipment);
  return [
    ...(via && via.status !== 'complete' ? shipment.via.map(portId => ({ portId, eta: via.at })) : []),
    { portId: shipment.destination, eta: shipment.eta },
  ];
}

/** What the ship concluded from the board this cycle: the rule-based floor, the queue estimates it moved, and every board message it relied on. */
export type Society = Readonly<{ floor: RiskFloor | null; queues: readonly Readonly<QueueDrainBasis & { bulletinId: string; hours: Readonly<{ low: number; likely: number; high: number }> }>[]}>;
export const noSociety: Society = { floor: null, queues: [] };
/** What a port's watchers say, whichever message carried it: the queue (traffic) or the weather (hazards). */
export type PortReport = Readonly<{ id: string; kind: BoardMessage['kind']; summary: string; at: string; portId: PortId; element: 'traffic' | 'hazards'; risk: PortRisk; anchored: number; arrivals48h: number; evidenceIds: readonly string[] }>;
export const portReportOf = (message: BoardMessage): PortReport | null => {
  switch (message.kind) {
    case 'city.traffic': return { id: message.id, kind: message.kind, summary: message.summary, at: message.at, portId: message.author.city, element: 'traffic', risk: message.risk, anchored: message.anchored, arrivals48h: message.arrivals48h, evidenceIds: message.evidenceIds };
    case 'city.hazards': return { id: message.id, kind: message.kind, summary: message.summary, at: message.at, portId: message.author.city, element: 'hazards', risk: message.risk, anchored: 0, arrivals48h: 0, evidenceIds: message.evidenceIds };
    default: return null;
  }
};

export type DecisionInput = Readonly<{ shipment: AssessedShipment; situation: Situation | null; now: string; society?: Society }>;

/** A ship says when its signals begin, once, and says when they clear, once: a port that counted it stops counting it. */
const observationOf = ({ shipment, situation, now }: DecisionInput, memory: ShipBoardMemory): readonly Outbound[] => {
  const telemetry = shipment.telemetry;
  if (!telemetry || situation?.id === memory.observed || (!situation && !memory.observed)) return [];
  const active = shipment.signals?.map(signal => signal.kind) ?? [];
  const signals = situation ? [...new Set(active.length ? active : situation.kinds)] : [];
  const measured = Object.assign({}, ...(shipment.signals ?? []).map(signal => signal.measured)) as NonNullable<ShipObservation['measured']>;
  const nearPort = nearestPortId(telemetry.position);
  const message: ShipObservation = {
    id: situation ? `obs:${situation.id}` : `obs:cleared:${memory.observed}`, kind: 'ship.observation', author: { role: 'ship', id: shipment.id, vessel: shipment.vessel, agent: shipment.agent }, at: now,
    summary: observationSummary(shipment.agent, shipment.vessel, situation ? shipment.signals?.map(signal => signal.title) ?? signals : ['signals cleared'], measured, nearPort),
    shipmentId: shipment.id, signals, measured, position: [telemetry.position[0], telemetry.position[1]], nearPort, provider: telemetry.provider, observedAt: telemetry.observedAt,
  };
  return [{ message, remember: current => ({ ...current, observed: situation?.id ?? null }) }];
};

const assessmentOf = ({ shipment, situation, now, society = noSociety }: DecisionInput, memory: ShipBoardMemory): readonly Outbound[] => {
  const known = memory.assessed ?? { risk: 'on-track' as Risk, eta: shipment.baselineEta };
  if (known.risk === shipment.risk && known.eta === shipment.eta) return [];
  const record = shipment.assessments?.[shipment.assessments.length - 1];
  const modelled = record?.method === 'ai-assessed' && (!situation || Date.parse(record.assessedAt) >= Date.parse(situation.startedAt));
  const rule = !modelled ? society.floor : null;
  const queue = rule ? society.queues[0] : undefined;
  const base = {
    id: `asm:${shipment.id}:${shipment.eta}:${shipment.risk}:${situation?.id ?? 'none'}`, kind: 'ship.assessment' as const, author: { role: 'ship' as const, id: shipment.id, vessel: shipment.vessel, agent: shipment.agent }, at: now,
    summary: assessedSummary(shipment.agent, shipment.vessel, { risk: shipment.risk, eta: shipment.eta }, shipment.change),
    shipmentId: shipment.id, risk: shipment.risk, eta: shipment.eta, ports: remainingCalls(shipment).map(call => call.portId),
  };
  const message: ShipAssessment = rule
    ? { ...base, summary: '', delayHours: queue?.hours ?? null, confidence: null, method: 'rule-based', citedEvidence: [...rule.citedEvidence], ...(queue ? { basis: { rule: queue.rule, portId: queue.portId, anchored: queue.anchored, serviceRate: queue.serviceRate } } : {}) }
    : { ...base, delayHours: record?.delayHours ?? null, confidence: record ? record.confidence : null, method: record?.method ?? 'deterministic', citedEvidence: [...(record?.citedEvidence ?? [])] };
  const spoken = rule ? { ...message, summary: ruleAssessmentSummary(shipment.agent, shipment.vessel, message, rule.reasons) } : message;
  return [{ message: spoken, remember: current => ({ ...current, assessed: { risk: shipment.risk, eta: shipment.eta } }) }];
};

const etasOf = ({ shipment, situation, now }: DecisionInput, memory: ShipBoardMemory): readonly Outbound[] =>
  remainingCalls(shipment).flatMap(({ portId, eta }) => memory.etas[portId] === eta ? [] : [{
    message: {
      id: `eta:${shipment.id}:${portId}:${eta}`, kind: 'ship.eta' as const, author: { role: 'ship' as const, id: shipment.id, vessel: shipment.vessel, agent: shipment.agent }, at: now,
      summary: etaSummary(shipment.agent, shipment.vessel, portId, eta, memory.etas[portId] ?? afterHours(eta, -shipment.delayHours)), shipmentId: shipment.id, portId, eta, ...(memory.etas[portId] ? { citedEvidence: [`asm:${shipment.id}:${shipment.eta}:${shipment.risk}:${situation?.id ?? 'none'}`] } : {}), previousEta: memory.etas[portId] ?? afterHours(eta, -shipment.delayHours),
    },
    remember: (current: ShipBoardMemory) => ({ ...current, etas: { ...current.etas, [portId]: eta } }),
  }]);

/** Pure: what this ship should say now, in the order it should say it. Ids are functions of the facts, so a replay is deduplicated by Relay. */
export const decideBoard = (memory: ShipBoardMemory, input: DecisionInput): readonly Outbound[] => [
  ...observationOf(input, memory),
  ...assessmentOf(input, memory),
  ...etasOf(input, memory),
];

/** The ship has decided: its memory moves on at once and the messages go to the durable outbox, whose delivery to Relay is retried until acknowledged. */
export const commitDecisions = (memory: ShipBoardMemory, outbound: readonly Outbound[]): Readonly<{ memory: ShipBoardMemory; messages: readonly BoardMessage[] }> => ({
  memory: outbound.reduce((current, item) => item.remember(current), memory),
  messages: outbound.map(item => item.message),
});

export const inHorizon = (at: string, now: string): boolean => Date.parse(now) - Date.parse(at) <= peerHorizonHours * 3_600_000 && Date.parse(at) <= Date.parse(now) + 60_000;

/** Pure: port bulletins for the ports still ahead and peers' observations near this ship's route, as assessment evidence cited by message id. */
export function selectBoardEvidence(shipment: AssessedShipment, board: readonly BoardMessage[], now: string): readonly BoardEvidence[] {
  const ahead = new Set(remainingCalls(shipment).map(call => call.portId));
  const route = voyageRoute(shipment) ?? shipment.route;
  const nearRoute = (position: LonLat): boolean =>
    route.length > 1 && nearestPointOnLine(lineString(route.map(item => [...item])), point([...position]), { units: 'kilometers' }).properties.pointDistance <= peerRouteKm;
  const latestFirst = <A extends Readonly<{ at: string }>>(items: readonly A[]): readonly A[] => [...items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const reports = board.flatMap(message => portReportOf(message) ?? []).filter(report => ahead.has(report.portId) && inHorizon(report.at, now));
  const newestPerWatch = latestFirst(reports).filter((report, index, sorted) => sorted.findIndex(other => other.portId === report.portId && other.element === report.element) === index).slice(0, maxBulletins);
  const peers = latestFirst(board.flatMap(message => message.kind === 'ship.observation' && message.shipmentId !== shipment.id && inHorizon(message.at, now) && nearRoute(message.position) ? [message] : [])).slice(0, maxPeers);
  return [
    ...newestPerWatch.map((report): BoardEvidence => ({ id: report.id, kind: report.kind, at: report.at, summary: report.summary, facts: { portId: report.portId, element: report.element, risk: report.risk, anchored: report.anchored, arrivals48h: report.arrivals48h } })),
    ...peers.map((message): BoardEvidence => ({ id: message.id, kind: message.kind, at: message.at, summary: message.summary, facts: { vessel: message.author.role === 'ship' ? message.author.vessel : null, signals: message.signals, nearPort: message.nearPort, position: message.position, observedAt: message.observedAt } })),
  ];
}

const maxRemembered = 50;
/** Pure: the ship's recent view of the board, since each read only sees what is past the cursor. Deduplicated by id and bounded by age; the newest 50 messages are kept, and every ship's latest observation besides, since the queue is ordered by them and a flood of ETAs must not push a stop off the board. */
export const rememberBoard = (previous: readonly BoardMessage[], incoming: readonly BoardMessage[], now: string): readonly BoardMessage[] => {
  const fresh = [...new Map([...previous, ...incoming].map(message => [message.id, message] as const)).values()]
    .filter(message => Date.parse(now) - Date.parse(message.at) <= peerHorizonHours * 3_600_000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const newest = new Set(fresh.slice(-maxRemembered).map(message => message.id));
  const latestStops = new Map<string, string>();
  fresh.forEach(message => { if (message.kind === 'ship.observation') latestStops.set(message.shipmentId, message.id); });
  const stops = new Set(latestStops.values());
  return fresh.filter(message => newest.has(message.id) || stops.has(message.id));
};
