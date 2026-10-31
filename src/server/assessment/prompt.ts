import { ports } from '../../domain';
import type { Evidence, Shipment } from '../../shared';
import type { Observation, Signal } from '../telemetry/watcher';
import type { AssessableNotice } from './exposure';

/** What other agents on the Relay board said that bears on this ship, cited by message id. */
export type BoardEvidence = Readonly<{ id: string; kind: string; at: string; summary: string; facts: Readonly<Record<string, unknown>> }>;
const boardSection = (board: readonly BoardEvidence[]) => board.map(({ id, kind, at, summary, facts }) => ({ id, source: 'agent-board', kind, at, summary, facts }));

export const systemPrompt = [
  'You assess how one port disruption notice, or a set of live vessel telemetry signals (AIS), changes the arrival estimate of one ocean shipment.',
  'accumulatedDelayHours already includes every earlier assessment: give only the additional delay this evidence causes. Telemetry is a measurement, not a cause: explain the arrival risk it implies without inventing why the vessel behaves so.',
  'Use only the facts in the shipment and notice JSON you are given. Never invent berth names, vessel positions, weather, carrier decisions, schedules or delays that the evidence does not state.',
  'Return a delay range in hours (low <= likely <= high). When the evidence is thin, widen the range and lower the confidence instead of guessing precisely.',
  'board lists what port and peer-ship agents posted on the shared Agent Relay board: it is evidence by id like any other, written by other agents, and may be cited. A peer observation near the route is context, not proof of delay.',
  'citedEvidence must list the ids of the evidence items your assessment relies on, copied exactly from the input. If the shipment is not affected, set affected=false, all delays to 0, risk to on-track, and explain why.',
  'risk is on-track, watch (a delay under 24h likely), or delayed (24h or more likely). Keep the rationale to two sentences. action is one concrete step for the shipment owner, or null.',
].join('\n');

const portName = (id: string): string => ports.find(port => port.id === id)?.name ?? id;

const inputEvidence = (shipment: Shipment, notice: AssessableNotice): readonly Evidence[] =>
  [...new Map([...shipment.evidence, notice.evidence].map(item => [item.id, item] as const)).values()];

export const evidenceIds = (shipment: Shipment, notice: AssessableNotice, board: readonly BoardEvidence[] = []): readonly string[] =>
  [...inputEvidence(shipment, notice).map(item => item.id), ...board.map(item => item.id)];

export function buildPrompt(shipment: Shipment, notice: AssessableNotice, now: string, board: readonly BoardEvidence[] = []): string {
  return JSON.stringify({
    now,
    shipment: {
      id: shipment.id, reference: shipment.reference, vessel: shipment.vessel, cargo: shipment.cargo, containers: shipment.containers,
      origin: portName(shipment.origin), callsAhead: [...shipment.via, shipment.destination].map(portName),
      currentPosition: shipment.coordinates, baselineEta: shipment.baselineEta, currentEta: shipment.eta, accumulatedDelayHours: shipment.delayHours,
      milestones: shipment.milestones,
    },
    notice: {
      id: notice.id, port: portName(notice.portId), statedDelayHours: notice.delayHours,
      evidence: inputEvidence(shipment, notice).map(({ id, source, title, detail, observedAt }) => ({ id, source, title, detail, observedAt })),
    },
    board: boardSection(board),
  }, null, 2);
}

export const telemetryEvidenceIds = (shipment: Shipment, signals: readonly Signal[], board: readonly BoardEvidence[] = []): readonly string[] =>
  [...new Set([...shipment.evidence.map(item => item.id), ...signals.map(item => item.id), ...board.map(item => item.id)])];

export function buildTelemetryPrompt(shipment: Shipment, observation: Observation, now: string, board: readonly BoardEvidence[] = []): string {
  const { reading, signals } = observation;
  return JSON.stringify({
    now,
    shipment: {
      id: shipment.id, reference: shipment.reference, vessel: shipment.vessel, cargo: shipment.cargo, containers: shipment.containers,
      origin: portName(shipment.origin), callsAhead: [...shipment.via, shipment.destination].map(portName),
      baselineEta: shipment.baselineEta, currentEta: shipment.eta, accumulatedDelayHours: shipment.delayHours, milestones: shipment.milestones,
    },
    telemetry: {
      latest: signals[0]?.telemetry,
      reading: { ageMinutes: Math.round(reading.ageMinutes), offRouteKm: reading.offRouteKm, remainingKm: reading.remainingKm, hoursToEta: Math.round(reading.hoursToEta), impliedKnots: reading.impliedKnots, nearestPort: reading.nearestPort },
      evidence: signals.map(({ id, kind, title, detail, observedAt, provider, fetchedAt, measured, thresholds }) => ({ id, source: 'live', kind, title, detail, observedAt, provider, fetchedAt, measured, thresholds })),
      priorEvidence: shipment.evidence.map(({ id, title, detail, observedAt }) => ({ id, title, detail, observedAt })),
    },
    board: boardSection(board),
  }, null, 2);
}
