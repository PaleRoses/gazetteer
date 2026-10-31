import { ports } from '../../domain';
import type { Evidence, Shipment } from '../../shared';
import type { Observation, Signal } from '../telemetry/watcher';
import type { AssessableNotice } from './exposure';

export const systemPrompt = [
  'You assess how one port disruption notice, or a set of live vessel telemetry signals (AIS), changes the arrival estimate of one ocean shipment.',
  'accumulatedDelayHours already includes every earlier assessment: give only the additional delay this evidence causes. Telemetry is a measurement, not a cause: explain the arrival risk it implies without inventing why the vessel behaves so.',
  'Use only the facts in the shipment and notice JSON you are given. Never invent berth names, vessel positions, weather, carrier decisions, schedules or delays that the evidence does not state.',
  'Return a delay range in hours (low <= likely <= high). When the evidence is thin, widen the range and lower the confidence instead of guessing precisely.',
  'citedEvidence must list the ids of the evidence items your assessment relies on, copied exactly from the input. If the shipment is not affected, set affected=false, all delays to 0, risk to on-track, and explain why.',
  'risk is on-track, watch (a delay under 24h likely), or delayed (24h or more likely). Keep the rationale to one short sentence describing the operational risk. action is one concrete step for the shipment owner, or null.',
].join('\n');

const portName = (id: string): string => ports.find(port => port.id === id)?.name ?? id;

const inputEvidence = (shipment: Shipment, notice: AssessableNotice): readonly Evidence[] =>
  [...new Map([...shipment.evidence, notice.evidence].map(item => [item.id, item] as const)).values()];

export const evidenceIds = (shipment: Shipment, notice: AssessableNotice): readonly string[] => inputEvidence(shipment, notice).map(item => item.id);

export function buildPrompt(shipment: Shipment, notice: AssessableNotice, now: string): string {
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
  }, null, 2);
}

export const telemetryEvidenceIds = (shipment: Shipment, signals: readonly Signal[]): readonly string[] =>
  [...new Set([...shipment.evidence.map(item => item.id), ...signals.map(item => item.id)])];

export function buildTelemetryPrompt(shipment: Shipment, observation: Observation, now: string): string {
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
  }, null, 2);
}
