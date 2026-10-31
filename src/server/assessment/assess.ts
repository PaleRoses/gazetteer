import { applyAssessment, applyFallback, type AssessedShipment, type Provenanced } from './apply';
import { isExposed, type AssessableNotice } from './exposure';
import { buildPrompt, evidenceIds, systemPrompt } from './prompt';
import { validateAssessment } from './schema';

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

/** Outcome-typed and total: provider failures and invalid output become a labelled deterministic fallback. */
export async function assessNotice(deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, notice: AssessableNotice): Promise<Settled> {
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const settle = (next: AssessedShipment, outcome: AssessmentOutcome, nextCache: AssessmentCache = cache): Settled => ({ shipment: next, cache: nextCache, outcome });
  if (shipment.appliedDisruptions.includes(notice.id)) return settle(shipment, { status: 'skipped', reason: 'already-applied' });
  if (!isExposed(shipment, notice)) return settle(shipment, { status: 'skipped', reason: 'not-exposed' });
  const key = cacheKey(shipment.id, notice.id);
  const cached = cache[key];
  if (cached) return settle(applyAssessment(shipment, notice, cached), { status: 'assessed', source: 'cache', model: cached.model, latencyMs: 0 });
  const fallback = (reason: string): Settled => settle(applyFallback(shipment, notice, reason, now), { status: 'fallback', reason });
  if (!deps.model) return fallback('no model API key configured');
  const started = Date.now();
  const result = await callModel(deps.model, { system: systemPrompt, prompt: buildPrompt(shipment, notice, now) });
  if (result.status === 'failed') return fallback(`provider failure: ${result.message}`);
  const verdict = validateAssessment(result.output, evidenceIds(shipment, notice));
  if (verdict.status === 'rejected') return fallback(`model output rejected: ${verdict.reason}`);
  const entry: Provenanced = { assessment: verdict.assessment, model: deps.modelId, assessedAt: now };
  return settle(applyAssessment(shipment, notice, entry), { status: 'assessed', source: 'model', model: deps.modelId, latencyMs: Date.now() - started }, { ...cache, [key]: entry });
}

export type Batch = Readonly<{ shipment: AssessedShipment; cache: AssessmentCache; outcomes: readonly AssessmentOutcome[] }>;

export const assessNotices = (deps: AssessDeps, cache: AssessmentCache, shipment: AssessedShipment, notices: readonly AssessableNotice[]): Promise<Batch> =>
  notices.reduce<Promise<Batch>>(async (previous, notice) => {
    const batch = await previous;
    const settled = await assessNotice(deps, batch.cache, batch.shipment, notice);
    return { shipment: settled.shipment, cache: settled.cache, outcomes: [...batch.outcomes, settled.outcome] };
  }, Promise.resolve({ shipment, cache, outcomes: [] }));
