import { assessDisruption } from '../../core/demo';
import { shiftEta } from '../../core/eta';
import { ports } from '../../core/ports';
import type { Evidence, Risk, Shipment } from '../../core/types';
import type { Signal } from '../telemetry/watcher';
import type { Telemetry } from '../telemetry/telemetry';
import type { Assessment } from './schema';
import type { AssessableNotice } from './exposure';

export type Method = 'ai-assessed' | 'deterministic-fallback';
export type Basis = 'port-notice' | 'live-telemetry';
export type AssessmentRecord = Readonly<{
  noticeId: string; basis?: Basis; method: Method; model: string | null; assessedAt: string; affected: boolean;
  delayHours: Readonly<{ low: number; likely: number; high: number }>; confidence: number | null;
  rationale: string; citedEvidence: readonly string[]; fallbackReason: string | null;
}>;
export type AssessedShipment = Shipment & Readonly<{ assessments?: readonly AssessmentRecord[]; telemetry?: Telemetry; signals?: readonly Signal[] }>;
/** What an assessment is about: a port notice or a live-telemetry situation. Live evidence is not a simulated `Evidence`, so it travels as `signals`. */
export type Subject = Readonly<{ id: string; basis: Basis; label: string; evidence: readonly Evidence[] }>;
export type Provenanced = Readonly<{ assessment: Assessment; model: string; assessedAt: string }>;

const severity: Readonly<Record<Risk, number>> = { 'on-track': 0, watch: 1, delayed: 2 };
export const worse = (a: Risk, b: Risk): Risk => severity[a] >= severity[b] ? a : b;
const portName = (id: string): string => ports.find(port => port.id === id)?.name ?? id;
const record = (shipment: AssessedShipment, entry: AssessmentRecord): readonly AssessmentRecord[] => [...(shipment.assessments ?? []), entry];

export const noticeSubject = (notice: AssessableNotice): Subject =>
  ({ id: notice.id, basis: 'port-notice', label: `${portName(notice.portId)} notice`, evidence: [notice.evidence] });

export const applyAssessment = (shipment: AssessedShipment, notice: AssessableNotice, provenanced: Provenanced): AssessedShipment =>
  applySubject(shipment, noticeSubject(notice), provenanced);

/** Pure and idempotent: a subject id already applied returns the very same shipment. */
export function applySubject(shipment: AssessedShipment, subject: Subject, { assessment, model, assessedAt }: Provenanced): AssessedShipment {
  if (shipment.appliedDisruptions.includes(subject.id)) return shipment;
  const entry: AssessmentRecord = {
    noticeId: subject.id, basis: subject.basis, method: 'ai-assessed', model, assessedAt, affected: assessment.affected, delayHours: assessment.delayHours,
    confidence: assessment.confidence, rationale: assessment.rationale, citedEvidence: assessment.citedEvidence, fallbackReason: null,
  };
  const settled = { appliedDisruptions: [...shipment.appliedDisruptions, subject.id], assessments: record(shipment, entry) };
  const label = `${subject.label} assessed by ${model}`;
  if (!assessment.affected) return { ...shipment, ...settled, change: `${label}: no change to the arrival estimate. ${assessment.rationale}` };
  const { low, likely, high } = assessment.delayHours;
  const shifted = shiftEta(shipment, likely);
  return {
    ...shifted, ...settled, risk: worse(shipment.risk, assessment.risk),
    change: `${label}: +${likely}h likely (range ${low}-${high}h, confidence ${Math.round(assessment.confidence * 100)}%). ${assessment.rationale}`,
    action: assessment.action ?? shipment.action,
    evidence: [...shipment.evidence, ...subject.evidence.filter(item => !shipment.evidence.some(known => known.id === item.id))],
  };
}

/** The synthetic arithmetic model, labelled as a fallback and never as AI. */
export function applyFallback(shipment: AssessedShipment, notice: AssessableNotice, reason: string, assessedAt: string): AssessedShipment {
  if (notice.delayHours === null) return shipment;
  const applied = assessDisruption(shipment, notice);
  if (applied === shipment) return shipment;
  const entry: AssessmentRecord = {
    noticeId: notice.id, method: 'deterministic-fallback', model: null, assessedAt, affected: true,
    delayHours: { low: notice.delayHours, likely: notice.delayHours, high: notice.delayHours }, confidence: null,
    rationale: applied.change, citedEvidence: [notice.evidence.id], fallbackReason: reason,
  };
  return { ...applied, change: `Deterministic fallback (${reason}): ${applied.change}`, assessments: record(shipment, entry) };
}
