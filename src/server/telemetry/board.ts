import nearestPointOnLine from '@turf/nearest-point-on-line';
import { lineString, point } from '@turf/helpers';
import type { BoardMessage, ShipAssessment, ShipObservation } from '../../board';
import { ports } from '../../domain';
import { distanceKm, voyageRoute } from '../../sea-routes';
import type { PortId, RelayOutcome, Risk } from '../../shared';
import type { AssessedShipment } from '../assessment/apply';
import type { BoardEvidence } from '../assessment/prompt';
import { describeError, type LonLat } from './telemetry';
import type { Situation } from './watcher';

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

const clip = (text: string): string => text.length <= 280 ? text : `${text.slice(0, 277)}...`;
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

export type DecisionInput = Readonly<{ shipment: AssessedShipment; situation: Situation | null; now: string }>;

const observationOf = ({ shipment, situation, now }: DecisionInput, memory: ShipBoardMemory): readonly Outbound[] => {
  const telemetry = shipment.telemetry;
  if (!situation || !telemetry || situation.id === memory.observed) return [];
  const active = shipment.signals?.map(signal => signal.kind) ?? [];
  const signals = [...new Set(active.length ? active : situation.kinds)];
  const message: ShipObservation = {
    id: `obs:${situation.id}`, kind: 'ship.observation', author: { role: 'ship', id: shipment.id, vessel: shipment.vessel }, at: now,
    summary: clip(`${shipment.vessel}: ${shipment.signals?.map(signal => signal.title).join('; ') || signals.join(', ')}.`),
    shipmentId: shipment.id, signals, position: [telemetry.position[0], telemetry.position[1]], nearPort: nearestPortId(telemetry.position), provider: telemetry.provider, observedAt: telemetry.observedAt,
  };
  return [{ message, remember: current => ({ ...current, observed: situation.id }) }];
};

const assessmentOf = ({ shipment, now }: DecisionInput, memory: ShipBoardMemory): readonly Outbound[] => {
  const known = memory.assessed ?? { risk: 'on-track' as Risk, eta: shipment.baselineEta };
  if (known.risk === shipment.risk && known.eta === shipment.eta) return [];
  const record = shipment.assessments?.[shipment.assessments.length - 1];
  const message: ShipAssessment = {
    id: `asm:${shipment.id}:${shipment.eta}:${shipment.risk}`, kind: 'ship.assessment', author: { role: 'ship', id: shipment.id, vessel: shipment.vessel }, at: now,
    summary: clip(`${shipment.reference} ${shipment.vessel}: ${shipment.risk}, ETA ${shipment.eta.slice(0, 16)}Z (+${shipment.delayHours}h). ${shipment.change}`),
    shipmentId: shipment.id, risk: shipment.risk, eta: shipment.eta, delayHours: record?.delayHours ?? null, confidence: record?.confidence ?? 0,
    method: record?.method ?? 'deterministic', citedEvidence: [...(record?.citedEvidence ?? [])], ports: remainingCalls(shipment).map(call => call.portId),
  };
  return [{ message, remember: current => ({ ...current, assessed: { risk: shipment.risk, eta: shipment.eta } }) }];
};

const etasOf = ({ shipment, now }: DecisionInput, memory: ShipBoardMemory): readonly Outbound[] =>
  remainingCalls(shipment).flatMap(({ portId, eta }) => memory.etas[portId] === eta ? [] : [{
    message: {
      id: `eta:${shipment.id}:${portId}:${eta}`, kind: 'ship.eta' as const, author: { role: 'ship' as const, id: shipment.id, vessel: shipment.vessel }, at: now,
      summary: clip(`${shipment.vessel} expects ${portId} at ${eta.slice(0, 16)}Z.`), shipmentId: shipment.id, portId, eta, previousEta: memory.etas[portId] ?? afterHours(eta, -shipment.delayHours),
    },
    remember: (current: ShipBoardMemory) => ({ ...current, etas: { ...current.etas, [portId]: eta } }),
  }]);

/** Pure: what this ship should say now, in the order it should say it. Ids are functions of the facts, so a replay is deduplicated by Relay. */
export const decideBoard = (memory: ShipBoardMemory, input: DecisionInput): readonly Outbound[] => [
  ...observationOf(input, memory),
  ...assessmentOf(input, memory),
  ...etasOf(input, memory),
];

/** Posts in order and remembers only what was acknowledged. Stops at the first failure and says why; never throws. */
export async function postDecisions(
  post: (message: BoardMessage) => Promise<RelayOutcome<string>>, memory: ShipBoardMemory, outbound: readonly Outbound[],
): Promise<Readonly<{ memory: ShipBoardMemory; failure: string | null }>> {
  return outbound.reduce<Promise<Readonly<{ memory: ShipBoardMemory; failure: string | null }>>>(async (previous, item) => {
    const state = await previous;
    if (state.failure) return state;
    const result = await post(item.message).catch((error: unknown): RelayOutcome<string> => ({ status: 'unavailable', message: describeError(error) }));
    return result.status === 'ok' ? { memory: item.remember(state.memory), failure: null } : { memory: state.memory, failure: result.message };
  }, Promise.resolve({ memory, failure: null }));
}

const inHorizon = (at: string, now: string): boolean => Date.parse(now) - Date.parse(at) <= peerHorizonHours * 3_600_000 && Date.parse(at) <= Date.parse(now) + 60_000;

/** Pure: port bulletins for the ports still ahead and peers' observations near this ship's route, as assessment evidence cited by message id. */
export function selectBoardEvidence(shipment: AssessedShipment, board: readonly BoardMessage[], now: string): readonly BoardEvidence[] {
  const ahead = new Set(remainingCalls(shipment).map(call => call.portId));
  const route = voyageRoute(shipment) ?? shipment.route;
  const nearRoute = (position: LonLat): boolean =>
    route.length > 1 && nearestPointOnLine(lineString(route.map(item => [...item])), point([...position]), { units: 'kilometers' }).properties.pointDistance <= peerRouteKm;
  const latestFirst = <A extends BoardMessage>(items: readonly A[]): readonly A[] => [...items].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const bulletins = latestFirst(board.flatMap(message => message.kind === 'port.bulletin' && ahead.has(message.portId) && inHorizon(message.at, now) ? [message] : []));
  const newestPerPort = bulletins.filter((message, index) => bulletins.findIndex(other => other.portId === message.portId) === index).slice(0, maxBulletins);
  const peers = latestFirst(board.flatMap(message => message.kind === 'ship.observation' && message.shipmentId !== shipment.id && inHorizon(message.at, now) && nearRoute(message.position) ? [message] : [])).slice(0, maxPeers);
  return [
    ...newestPerPort.map((message): BoardEvidence => ({ id: message.id, kind: message.kind, at: message.at, summary: message.summary, facts: { portId: message.portId, risk: message.risk, anchored: message.anchored, arrivals48h: message.arrivals48h } })),
    ...peers.map((message): BoardEvidence => ({ id: message.id, kind: message.kind, at: message.at, summary: message.summary, facts: { vessel: message.author.role === 'ship' ? message.author.vessel : null, signals: message.signals, nearPort: message.nearPort, position: message.position, observedAt: message.observedAt } })),
  ];
}

const maxRemembered = 50;
/** Pure: the ship's recent view of the board, since each read only sees what is past the cursor. Deduplicated by id, bounded by age and count. */
export const rememberBoard = (previous: readonly BoardMessage[], incoming: readonly BoardMessage[], now: string): readonly BoardMessage[] =>
  [...new Map([...previous, ...incoming].map(message => [message.id, message] as const)).values()]
    .filter(message => Date.parse(now) - Date.parse(message.at) <= peerHorizonHours * 3_600_000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-maxRemembered);
