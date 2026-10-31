import { applyFallback, applySubject, noticeSubject, type AssessedShipment, type Provenanced, type Subject } from './apply';
import { isExposed, type AssessableNotice } from './exposure';
import { buildPrompt, buildTelemetryPrompt, evidenceIds, systemPrompt, telemetryEvidenceIds, type BoardEvidence } from './prompt';
import { keepShown, validateAssessment } from './schema';
import type { Observation, Situation } from '../telemetry/watcher';

/** What a ship mind may look at through its tools: the ship, the board evidence it was given, and its live observation if any. */
export type MindContext = Readonly<{ shipment: AssessedShipment; board: readonly BoardEvidence[]; observation: Observation | null }>;
/** `session` is the mind's own conversation to resume; a single-call model ignores it and the context. */
export type ModelRequest = Readonly<{ system: string; prompt: string; session: string | null; context: MindContext }>;
/** A mind reports the session it ran in (null: forget it) and the ids its tools showed; citations of anything else are dropped. */
export type ModelResult =
  | Readonly<{ status: 'ok'; output: unknown; session?: string | null; shown?: readonly string[] }>
  | Readonly<{ status: 'failed'; message: string; session?: string | null }>;
export type AssessModel = (request: ModelRequest) => Promise<ModelResult>;
export type AssessDeps = Readonly<{ model: AssessModel | null; modelId: string; now?: () => string; session?: string | null }>;
export type AssessmentCache = Readonly<Record<string, Provenanced>>;
export type AssessmentOutcome =
  | Readonly<{ status: 'skipped'; reason: 'already-applied' | 'not-exposed' }>
  | Readonly<{ status: 'assessed'; source: 'model' | 'cache'; model: string; latencyMs: number }>
  | Readonly<{ status: 'fallback'; reason: string }>;
export type Settled = Readonly<{ shipment: AssessedShipment; cache: AssessmentCache; outcome: AssessmentOutcome; session: string | null }>;

export const cacheKey = (shipmentId: string, noticeId: string): string => `${shipmentId}:${noticeId}`;
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

const callModel = async (model: AssessModel, request: ModelRequest): Promise<ModelResult> => {
  try { return await model(request); } catch (error) { return { status: 'failed', message: message(error) }; }
};

type Trigger = Readonly<{
  subject: Subject; exposed: boolean; allowedEvidence: readonly string[]; context: MindContext; prompt: (now: string) => string;
  fallback: (shipment: AssessedShipment, reason: string, now: string) => AssessedShipment;
}>;

/** Outcome-typed and total: provider failures and invalid output become a labelled fallback, never a throw and never AI. */
async function assessTrigger(deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, trigger: Trigger): Promise<Settled> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const session = deps.session ?? null;
  const settle = (next: AssessedShipment, outcome: AssessmentOutcome, nextCache: AssessmentCache = cache, nextSession: string | null = session): Settled =>
    ({ shipment: next, cache: nextCache, outcome, session: nextSession });
  const { subject } = trigger;
  if (shipment.appliedDisruptions.includes(subject.id)) return settle(shipment, { status: 'skipped', reason: 'already-applied' });
  if (!trigger.exposed) return settle(shipment, { status: 'skipped', reason: 'not-exposed' });
  const key = cacheKey(shipment.id, subject.id);
  const cached = cache[key];
  if (cached) return settle(applySubject(shipment, subject, cached), { status: 'assessed', source: 'cache', model: cached.model, latencyMs: 0 });
  const fallback = (reason: string, nextSession: string | null = session): Settled => settle(trigger.fallback(shipment, reason, now), { status: 'fallback', reason }, cache, nextSession);
  if (!deps.model) return fallback('no model API key configured');
  const started = Date.now();
  const result = await callModel(deps.model, { system: systemPrompt, prompt: trigger.prompt(now), session, context: trigger.context });
  const after = result.session === undefined ? session : result.session;
  if (result.status === 'failed') return fallback(`provider failure: ${result.message}`, after);
  const shown = [...trigger.allowedEvidence, ...(result.shown ?? [])];
  const verdict = validateAssessment(result.shown ? keepShown(result.output, shown) : result.output, shown);
  if (verdict.status === 'rejected') return fallback(`model output rejected: ${verdict.reason}`, after);
  const entry: Provenanced = { assessment: verdict.assessment, model: deps.modelId, assessedAt: now };
  return settle(applySubject(shipment, subject, entry), { status: 'assessed', source: 'model', model: deps.modelId, latencyMs: Date.now() - started }, { ...cache, [key]: entry }, after);
}

export const assessNotice = (deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, notice: AssessableNotice, board: readonly BoardEvidence[] = []): Promise<Settled> =>
  assessTrigger(deps, cache, shipment, {
    subject: noticeSubject(notice), exposed: isExposed(shipment, notice), allowedEvidence: evidenceIds(shipment, notice, board), context: { shipment, board, observation: null },
    prompt: now => buildPrompt(shipment, notice, now, board), fallback: (current, reason, now) => applyFallback(current, notice, reason, now),
  });

/** A telemetry situation is already specific to the ship, so the port pre-filter does not apply. Without a model the ETA stays untouched: telemetry alone never invents a delay. */
export const assessTelemetry = (deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, situation: Situation, observation: Observation, board: readonly BoardEvidence[] = []): Promise<Settled> =>
  assessTrigger(deps, cache, shipment, {
    subject: { id: situation.id, basis: 'live-telemetry', label: `Live telemetry (${observation.signals[0]?.provider ?? 'AIS'})`, evidence: [] },
    exposed: observation.signals.length > 0, allowedEvidence: telemetryEvidenceIds(shipment, observation.signals, board), context: { shipment, board, observation },
    prompt: now => buildTelemetryPrompt(shipment, observation, now, board), fallback: current => current,
  });

export type Batch = Readonly<{ shipment: AssessedShipment; cache: AssessmentCache; outcomes: readonly AssessmentOutcome[]; session: string | null }>;

export const assessNotices = (deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, notices: readonly AssessableNotice[], board: readonly BoardEvidence[] = []): Promise<Batch> =>
  notices.reduce<Promise<Batch>>(async (previous, notice) => {
    const batch = await previous;
    const settled = await assessNotice({ ...deps, session: batch.session }, batch.cache, batch.shipment, notice, board);
    return { shipment: settled.shipment, cache: settled.cache, outcomes: [...batch.outcomes, settled.outcome], session: settled.session };
  }, Promise.resolve({ shipment, cache, outcomes: [], session: deps.session ?? null }));
