import { describe, expect, test } from 'bun:test';
import { assessDisruption, demoShipments } from '../src/domain';
import { applyAssessment, assessNotice, assessNotices, cacheKey, evidenceIds, isExposed, validateAssessment, type AssessableNotice, type AssessDeps, type AssessmentCache, type AssessModel, type Assessment } from '../src/server/assessment';

const at = '2026-10-31T12:00:00.000Z';
const [meridian, laurel, atlas, northern] = demoShipments(new Date(at)) as [ReturnType<typeof demoShipments>[number], ...ReturnType<typeof demoShipments>];
const notice: AssessableNotice = { id: 'sg-1', portId: 'singapore', delayHours: 36,
  evidence: { id: 'sg-1', source: 'simulation', title: 'Berth congestion', detail: 'Simulated congestion at Singapore.', observedAt: at } };
const good: Assessment = { affected: true, delayHours: { low: 12, likely: 20, high: 40 }, risk: 'watch', rationale: 'Berth queue at the next call.', citedEvidence: ['sg-1'], confidence: 0.6, action: 'Alert the consignee.' };
const counted = (output: unknown): { model: AssessModel; calls: () => number } => {
  let calls = 0;
  return { model: async () => { calls += 1; return { status: 'ok', output }; }, calls: () => calls };
};
const depsOf = (model: AssessModel | null): AssessDeps => ({ model, modelId: 'test-model', now: () => at });

describe('exposure pre-filter', () => {
  test('only shipments with an upcoming call at the port are exposed', () => {
    expect([meridian, laurel, atlas, northern].map(shipment => isExposed(shipment, notice))).toEqual([true, false, true, false]);
  });
  test('a departed origin is not exposed, but a notice geometry over the remaining route is', () => {
    const shanghai = { ...notice, portId: 'shanghai' as const };
    const midPacific = { center: [-165, 38] as const, radiusKm: 200 };
    expect(isExposed(laurel, shanghai)).toBe(false);
    expect(isExposed(laurel, { ...shanghai, geometry: midPacific })).toBe(true);
    expect(isExposed(atlas, { ...shanghai, geometry: midPacific })).toBe(false);
  });
  test('an unexposed shipment makes no model call and comes back identical', async () => {
    const { model, calls } = counted(good);
    const settled = await assessNotice(depsOf(model), {}, laurel, notice);
    expect(calls()).toBe(0);
    expect(settled.shipment).toBe(laurel);
    expect(settled.outcome).toEqual({ status: 'skipped', reason: 'not-exposed' });
  });
});

describe('assessment schema', () => {
  const allowed = ['sg-1'];
  test('accepts a grounded, ordered assessment', () => {
    expect(validateAssessment(good, allowed).status).toBe('valid');
  });
  test('rejects fabricated evidence ids', () => {
    const verdict = validateAssessment({ ...good, citedEvidence: ['sg-1', 'reuters-9'] }, allowed);
    expect(verdict).toEqual({ status: 'rejected', reason: expect.stringContaining('reuters-9') });
  });
  test('rejects inverted ranges, missing citations, and delay on an unaffected verdict', () => {
    expect(validateAssessment({ ...good, delayHours: { low: 30, likely: 20, high: 40 } }, allowed).status).toBe('rejected');
    expect(validateAssessment({ ...good, delayHours: { low: 12, likely: 50, high: 40 } }, allowed).status).toBe('rejected');
    expect(validateAssessment({ ...good, citedEvidence: [] }, allowed).status).toBe('rejected');
    expect(validateAssessment({ ...good, affected: false }, allowed).status).toBe('rejected');
  });
  test('rejects malformed output', () => {
    expect(validateAssessment({ ...good, confidence: 1.4 }, allowed).status).toBe('rejected');
    expect(validateAssessment('delayed by a week', allowed).status).toBe('rejected');
  });
  test('the evidence the model may cite is the shipment history plus the notice', () => {
    const prior = { ...notice.evidence, id: 'older' };
    expect(evidenceIds({ ...meridian, evidence: [prior] }, notice)).toEqual(['older', 'sg-1']);
  });
});

describe('apply', () => {
  const provenance = { assessment: good, model: 'test-model', assessedAt: at };
  test('revises the ETA by the likely delay and records provenance', () => {
    const next = applyAssessment(meridian, notice, provenance);
    expect(Date.parse(next.eta) - Date.parse(next.baselineEta)).toBe(20 * 3_600_000);
    expect(next.risk).toBe('watch');
    expect(next.evidence).toEqual([notice.evidence]);
    expect(next.assessments).toEqual([expect.objectContaining({ noticeId: 'sg-1', method: 'ai-assessed', model: 'test-model', confidence: 0.6 })]);
    expect(next.milestones[0]).toEqual(meridian.milestones[0]);
  });
  test('replay never adds the delay twice', () => {
    const once = applyAssessment(meridian, notice, provenance);
    expect(applyAssessment(once, notice, provenance)).toBe(once);
  });
  test('distinct notices accumulate and risk never improves', () => {
    const first = applyAssessment(meridian, notice, { ...provenance, assessment: { ...good, risk: 'delayed' } });
    const second = applyAssessment(first, { ...notice, id: 'sg-2', evidence: { ...notice.evidence, id: 'sg-2' } }, { ...provenance, assessment: { ...good, citedEvidence: ['sg-2'] } });
    expect(second.delayHours).toBe(40);
    expect(second.risk).toBe('delayed');
  });
  test('a verdict of unaffected settles the notice without moving the ETA', () => {
    const next = applyAssessment(meridian, notice, { ...provenance, assessment: { ...good, affected: false, delayHours: { low: 0, likely: 0, high: 0 }, risk: 'on-track', citedEvidence: [] } });
    expect(next.eta).toBe(meridian.eta);
    expect(next.appliedDisruptions).toEqual(['sg-1']);
  });
});

describe('assessment pipeline', () => {
  test('a cache hit makes no call and returns the same answer', async () => {
    const { model, calls } = counted(good);
    const first = await assessNotice(depsOf(model), {}, meridian, notice);
    expect(first.outcome).toMatchObject({ status: 'assessed', source: 'model' });
    expect(Object.keys(first.cache)).toEqual([cacheKey('gz-1042', 'sg-1')]);
    const replayed = await assessNotice(depsOf(model), first.cache, meridian, notice);
    expect(calls()).toBe(1);
    expect(replayed.outcome).toMatchObject({ status: 'assessed', source: 'cache' });
    expect(replayed.shipment).toEqual(first.shipment);
  });
  test('an already-applied notice is skipped without a call', async () => {
    const { model, calls } = counted(good);
    const first = await assessNotice(depsOf(model), {}, meridian, notice);
    const again = await assessNotice(depsOf(model), {}, first.shipment, notice);
    expect(calls()).toBe(1);
    expect(again.shipment).toBe(first.shipment);
    expect(again.outcome).toEqual({ status: 'skipped', reason: 'already-applied' });
  });
  test('without a model the deterministic answer is labelled as a fallback, never as AI', async () => {
    const settled = await assessNotice(depsOf(null), {}, meridian, notice);
    expect(settled.outcome).toMatchObject({ status: 'fallback' });
    expect(settled.shipment.delayHours).toBe(assessDisruption(meridian, notice).delayHours);
    expect(settled.shipment.change).toStartWith('Deterministic fallback');
    expect(settled.shipment.assessments).toEqual([expect.objectContaining({ method: 'deterministic-fallback', model: null })]);
    expect(settled.cache).toEqual({});
  });
  test('provider failures and thrown errors are data', async () => {
    const failing = await assessNotice(depsOf(async () => ({ status: 'failed', message: '529 overloaded' })), {}, meridian, notice);
    expect(failing.outcome).toEqual({ status: 'fallback', reason: 'provider failure: 529 overloaded' });
    const throwing = await assessNotice(depsOf(async () => { throw new Error('socket hang up'); }), {}, atlas, notice);
    expect(throwing.outcome).toEqual({ status: 'fallback', reason: 'provider failure: socket hang up' });
  });
  test('output citing invented evidence is rejected into a labelled fallback', async () => {
    const settled = await assessNotice(depsOf(counted({ ...good, citedEvidence: ['invented'] }).model), {}, meridian, notice);
    expect(settled.outcome).toMatchObject({ status: 'fallback', reason: expect.stringContaining('invented') });
    expect(settled.shipment.assessments?.[0]?.method).toBe('deterministic-fallback');
  });
  test('a replayed feed costs one call per exposed shipment and none for the unexposed', async () => {
    const { model, calls } = counted(good);
    const feed = [notice, notice];
    const run = (shipment: typeof meridian, cache: AssessmentCache) => assessNotices(depsOf(model), cache, shipment, feed);
    const exposed = await run(meridian, {});
    const unexposed = await run(laurel, {});
    expect(calls()).toBe(1);
    expect(exposed.shipment.delayHours).toBe(20);
    expect(unexposed.shipment).toBe(laurel);
  });
});

describe('environment edge', () => {
  test('no key means no model; a malformed workspace id fails as data, never as a throw', async () => {
    const { assessmentFromEnv } = await import('../src/server/assessment');
    expect(assessmentFromEnv({}).model).toBeNull();
    const bad = assessmentFromEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_WORKSPACE_ID: 'default' });
    expect(await bad.model!({ system: '', prompt: '' })).toEqual({ status: 'failed', message: expect.stringContaining('wrkspc_') });
    expect(assessmentFromEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_WORKSPACE_ID: 'wrkspc_abc123' }).model).not.toBeNull();
  });
});
