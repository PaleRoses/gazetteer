import { assessDisruption, ports } from '../../domain';
import type { Risk, Shipment } from '../../shared';
import type { Assessment } from './schema';
import type { AssessableNotice } from './exposure';

export type Method = 'ai-assessed' | 'deterministic-fallback';
export type AssessmentRecord = Readonly<{
  noticeId: string; method: Method; model: string | null; assessedAt: string; affected: boolean;
  delayHours: Readonly<{ low: number; likely: number; high: number }>; confidence: number | null;
  rationale: string; citedEvidence: readonly string[]; fallbackReason: string | null;
}>;
export type AssessedShipment = Shipment & Readonly<{ assessments?: readonly AssessmentRecord[] }>;
export type Provenanced = Readonly<{ assessment: Assessment; model: string; assessedAt: string }>;

const afterHours = (at: string, hours: number): string => new Date(Date.parse(at) + hours * 3_600_000).toISOString();
const severity: Readonly<Record<Risk, number>> = { 'on-track': 0, watch: 1, delayed: 2 };
const worse = (a: Risk, b: Risk): Risk => severity[a] >= severity[b] ? a : b;
const portName = (id: string): string => ports.find(port => port.id === id)?.name ?? id;
const record = (shipment: AssessedShipment, entry: AssessmentRecord): readonly AssessmentRecord[] => [...(shipment.assessments ?? []), entry];

/** Pure and idempotent: a notice id already applied returns the very same shipment. */
export function applyAssessment(shipment: AssessedShipment, notice: AssessableNotice, { assessment, model, assessedAt }: Provenanced): AssessedShipment {
  if (shipment.appliedDisruptions.includes(notice.id)) return shipment;
  const entry: AssessmentRecord = {
    noticeId: notice.id, method: 'ai-assessed', model, assessedAt, affected: assessment.affected, delayHours: assessment.delayHours,
    confidence: assessment.confidence, rationale: assessment.rationale, citedEvidence: assessment.citedEvidence, fallbackReason: null,
  };
  const settled = { appliedDisruptions: [...shipment.appliedDisruptions, notice.id], assessments: record(shipment, entry) };
  const label = `${portName(notice.portId)} notice assessed by ${model}`;
  if (!assessment.affected) return { ...shipment, ...settled, change: `${label}: no change to the arrival estimate. ${assessment.rationale}` };
  const { low, likely, high } = assessment.delayHours;
  const delayHours = shipment.delayHours + likely;
  return {
    ...shipment, ...settled, delayHours, eta: afterHours(shipment.baselineEta, delayHours), risk: worse(shipment.risk, assessment.risk),
    change: `${label}: +${likely}h likely (range ${low}-${high}h, confidence ${Math.round(assessment.confidence * 100)}%). ${assessment.rationale}`,
    action: assessment.action ?? shipment.action,
    milestones: shipment.milestones.map(milestone => milestone.status === 'complete' ? milestone : { ...milestone, at: afterHours(milestone.at, likely) }),
    evidence: [...shipment.evidence, ...(shipment.evidence.some(item => item.id === notice.evidence.id) ? [] : [notice.evidence])],
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
