import { applyFallback, applySubject, noticeSubject, type AssessedShipment, type Provenanced, type Subject } from './apply';
import { isExposed, type AssessableNotice } from './exposure';
import { buildPrompt, buildTelemetryPrompt, evidenceIds, systemPrompt, telemetryEvidenceIds } from './prompt';
import { validateAssessment } from './schema';
import type { Observation, Situation } from '../telemetry/watcher';

export type ModelRequest = Readonly<{ system: string; prompt: string }>;
export type ModelResult = Readonly<{ status: 'ok'; output: unknown }> | Readonly<{ status: 'failed'; message: string }>;
export type AssessModel = (request: ModelRequest) => Promise<ModelResult>;
export type AssessDeps = Readonly<{ model: AssessModel | null; modelId: string; now?: () => string }>;
export type AssessmentCache = Readonly<Record<string, Provenanced>>;
export type AssessmentOutcome =
  | Readonly<{ status: 'skipped'; reason: 'already-applied' | 'not-exposed' }>
  | Readonly<{ status: 'assessed'; source: 'model' | 'cache'; model: string; latencyMs: number }>
  | Readonly<{ status: 'fallback'; reason: string }>;
export type Settled = Readonly<{ shipment: AssessedShipment; cache: AssessmentCache; outcome: AssessmentOutcome }>;

export const cacheKey = (shipmentId: string, noticeId: string): string => `${shipmentId}:${noticeId}`;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const callModel = async (model: AssessModel, request: ModelRequest): Promise<ModelResult> => {
  try { return await model(request); } catch (error) { return { status: 'failed', message: message(error) }; }
};

type Trigger = Readonly<{
  subject: Subject; exposed: boolean; allowedEvidence: readonly string[]; prompt: (now: string) => string;
  fallback: (shipment: AssessedShipment, reason: string, now: string) => AssessedShipment;
}>;

/** Outcome-typed and total: provider failures and invalid output become a labelled fallback, never a throw and never AI. */
async function assessTrigger(deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, trigger: Trigger): Promise<Settled> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const settle = (next: AssessedShipment, outcome: AssessmentOutcome, nextCache: AssessmentCache = cache): Settled => ({ shipment: next, cache: nextCache, outcome });
  const { subject } = trigger;
  if (shipment.appliedDisruptions.includes(subject.id)) return settle(shipment, { status: 'skipped', reason: 'already-applied' });
  if (!trigger.exposed) return settle(shipment, { status: 'skipped', reason: 'not-exposed' });
  const key = cacheKey(shipment.id, subject.id);
  const cached = cache[key];
  if (cached) return settle(applySubject(shipment, subject, cached), { status: 'assessed', source: 'cache', model: cached.model, latencyMs: 0 });
  const fallback = (reason: string): Settled => settle(trigger.fallback(shipment, reason, now), { status: 'fallback', reason });
  if (!deps.model) return fallback('no model API key configured');
  const started = Date.now();
  const result = await callModel(deps.model, { system: systemPrompt, prompt: trigger.prompt(now) });
  if (result.status === 'failed') return fallback(`provider failure: ${result.message}`);
  const verdict = validateAssessment(result.output, trigger.allowedEvidence);
  if (verdict.status === 'rejected') return fallback(`model output rejected: ${verdict.reason}`);
  const entry: Provenanced = { assessment: verdict.assessment, model: deps.modelId, assessedAt: now };
  return settle(applySubject(shipment, subject, entry), { status: 'assessed', source: 'model', model: deps.modelId, latencyMs: Date.now() - started }, { ...cache, [key]: entry });
}

export const assessNotice = (deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, notice: AssessableNotice): Promise<Settled> =>
  assessTrigger(deps, cache, shipment, {
    subject: noticeSubject(notice), exposed: isExposed(shipment, notice), allowedEvidence: evidenceIds(shipment, notice),
    prompt: now => buildPrompt(shipment, notice, now), fallback: (current, reason, now) => applyFallback(current, notice, reason, now),
  });

/** A telemetry situation is already specific to the ship, so the port pre-filter does not apply. Without a model the ETA stays untouched: telemetry alone never invents a delay. */
export const assessTelemetry = (deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, situation: Situation, observation: Observation): Promise<Settled> =>
  assessTrigger(deps, cache, shipment, {
    subject: { id: situation.id, basis: 'live-telemetry', label: `Live telemetry (${observation.signals[0]?.provider ?? 'AIS'})`, evidence: [] },
    exposed: observation.signals.length > 0, allowedEvidence: telemetryEvidenceIds(shipment, observation.signals),
    prompt: now => buildTelemetryPrompt(shipment, observation, now), fallback: current => current,
  });

export type Batch = Readonly<{ shipment: AssessedShipment; cache: AssessmentCache; outcomes: readonly AssessmentOutcome[] }>;

export const assessNotices = (deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, notices: readonly AssessableNotice[]): Promise<Batch> =>
  notices.reduce<Promise<Batch>>(async (previous, notice) => {
    const batch = await previous;
    const settled = await assessNotice(deps, batch.cache, batch.shipment, notice);
    return { shipment: settled.shipment, cache: settled.cache, outcomes: [...batch.outcomes, settled.outcome] };
  }, Promise.resolve({ shipment, cache, outcomes: [] }));
