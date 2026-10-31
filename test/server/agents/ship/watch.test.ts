import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../../../src/core/demo';
import { positionAlong, routeLengthKm, voyageRoute, type Route } from '../../../../src/core/routes';
import type { Shipment } from '../../../../src/core/types';
import type { AssessDeps, AssessModel } from '../../../../src/server/assessment/assess';
import { emptyTelemetryState, watchShipment } from '../../../../src/server/agents/ship/watch';
import type { Telemetry, TelemetrySource } from '../../../../src/server/telemetry/telemetry';
const now = '2026-10-31T12:00:00.000Z';
const base = demoShipments(new Date(now))[2]!;
const route: Route = voyageRoute(base) ?? base.route;
const fraction = 0.3;
const remainingKm = (1 - fraction) * routeLengthKm(route);
const eta = new Date(Date.parse(now) + remainingKm / 1.852 / 14 * 3_600_000).toISOString();
const shipment: Shipment = { ...base, eta, baselineEta: eta };
const position = positionAlong(route, fraction)!;
const report = (overrides: Partial<Telemetry> = {}): Telemetry =>
  ({ mmsi: '563012345', position, sogKnots: 5, cogDegrees: 120, navStatus: 0, observedAt: now, provenance: 'live', provider: 'aisstream', fetchedAt: now, ...overrides });
const sourceOf = (telemetry: Telemetry | string): TelemetrySource => async () => typeof telemetry === 'string' ? { status: 'unavailable', message: telemetry } : { status: 'ok', value: telemetry };
const verdict = (citedEvidence: readonly string[]) => ({ affected: true, delayHours: { low: 30, likely: 48, high: 90 }, risk: 'delayed', rationale: 'Five knots against fourteen needed.', citedEvidence, confidence: 0.55, action: 'Ask the carrier for a revised berth window.' });
const counted = (output: (prompt: string) => unknown): { model: AssessModel; prompts: string[] } => {
  const prompts: string[] = [];
  return { model: async ({ prompt }) => { prompts.push(prompt); return { status: 'ok', output: output(prompt) }; }, prompts };
};
const assessOf = (model: AssessModel | null): AssessDeps => ({ model, modelId: 'test-model', now: () => now });
const signalId = (prompt: string): string => (JSON.parse(prompt) as { telemetry: { evidence: { id: string }[] } }).telemetry.evidence[0]!.id;

describe('watch cycle', () => {
  test('an untracked ship is returned untouched and nothing is fetched', async () => {
    const step = await watchShipment({ source: async () => { throw new Error('must not be called'); }, assess: assessOf(null), now: () => now }, shipment, null, emptyTelemetryState, {});
    expect(step.shipment).toBe(shipment);
    expect(step.report).toEqual({ status: 'untracked' });
  });

  test('no position yet is a typed report, not a change', async () => {
    const step = await watchShipment({ source: sourceOf('aisstream: no position report yet'), assess: assessOf(null), now: () => now }, shipment, '563012345', emptyTelemetryState, {});
    expect(step.shipment).toBe(shipment);
    expect(step.report).toEqual({ status: 'no-position', message: 'aisstream: no position report yet' });
  });

  test('slow steaming is assessed once; the model sees the live evidence and its citation is kept; replays add nothing', async () => {
    const { model, prompts } = counted(prompt => verdict([signalId(prompt)]));
    const deps = { source: sourceOf(report()), assess: assessOf(model), now: () => now };
    const first = await watchShipment(deps, shipment, '563012345', emptyTelemetryState, {});
    expect(prompts).toHaveLength(1);
    const sent = JSON.parse(prompts[0]!) as { telemetry: { latest: Telemetry; reading: { impliedKnots: number }; evidence: { source: string; kind: string; provider: string; fetchedAt: string }[] } };
    expect(sent.telemetry.latest.sogKnots).toBe(5);
    expect(sent.telemetry.reading.impliedKnots).toBeCloseTo(14, 0);
    expect(sent.telemetry.evidence[0]).toMatchObject({ source: 'live', kind: 'slow-steaming', provider: 'aisstream', fetchedAt: now });
    expect(first.report).toMatchObject({ status: 'watched', fetch: 'fresh', signals: 1, assessment: { status: 'assessed', source: 'model' } });
    expect(first.shipment.delayHours).toBe(48);
    expect(first.shipment.assessments).toEqual([expect.objectContaining({ basis: 'live-telemetry', method: 'ai-assessed', model: 'test-model', citedEvidence: [expect.stringContaining('slow-steaming')] })]);
    expect(first.shipment.signals?.[0]?.provenance).toBe('live');
    expect(first.shipment.telemetry).toEqual(report());

    const again = await watchShipment(deps, first.shipment, '563012345', first.state, first.cache);
    expect(prompts).toHaveLength(1);
    expect(again.shipment.delayHours).toBe(48);
    expect(again.report).toMatchObject({ assessment: { status: 'skipped', reason: 'already-applied' } });
  });

  test('a citation outside the telemetry evidence is rejected; the ETA is untouched, the signals still show, and the label says fallback', async () => {
    const { model } = counted(() => verdict(['made-up-id']));
    const step = await watchShipment({ source: sourceOf(report()), assess: assessOf(model), now: () => now }, shipment, '563012345', emptyTelemetryState, {});
    expect(step.report).toMatchObject({ assessment: { status: 'fallback', reason: expect.stringContaining('made-up-id') } });
    expect(step.shipment.eta).toBe(shipment.eta);
    expect(step.shipment.delayHours).toBe(0);
    expect(step.shipment.signals).toHaveLength(1);
    expect(step.shipment.appliedDisruptions).toEqual([]);
  });

  test('without a model, telemetry alone never moves the ETA', async () => {
    const step = await watchShipment({ source: sourceOf(report()), assess: assessOf(null), now: () => now }, shipment, '563012345', emptyTelemetryState, {});
    expect(step.report).toMatchObject({ assessment: { status: 'fallback', reason: 'no model API key configured' } });
    expect(step.shipment.eta).toBe(shipment.eta);
    expect(step.shipment.signals).toHaveLength(1);
  });

  test('a healthy vessel makes no model call', async () => {
    const { model, prompts } = counted(() => verdict([]));
    const step = await watchShipment({ source: sourceOf(report({ sogKnots: 14 })), assess: assessOf(model), now: () => now }, shipment, '563012345', emptyTelemetryState, {});
    expect(prompts).toHaveLength(0);
    expect(step.report).toMatchObject({ status: 'watched', signals: 0, assessment: null });
    expect(step.shipment.signals).toEqual([]);
  });

  test('when the feed drops, the persisted last position ages into an AIS-dark signal', async () => {
    const healthy = await watchShipment({ source: sourceOf(report({ sogKnots: 14 })), assess: assessOf(null), now: () => now }, shipment, '563012345', emptyTelemetryState, {});
    const later = new Date(Date.parse(now) + 13 * 3_600_000).toISOString();
    const step = await watchShipment({ source: sourceOf('digitraffic is unreachable'), assess: assessOf(null), now: () => later }, healthy.shipment, '563012345', healthy.state, healthy.cache);
    expect(step.report).toMatchObject({ status: 'watched', fetch: 'stale', fetchMessage: 'digitraffic is unreachable', signals: 1 });
    expect(step.shipment.signals?.[0]?.kind).toBe('ais-dark');
  });

  test('a throwing source is data', async () => {
    const step = await watchShipment({ source: async () => { throw new Error('socket exploded'); }, assess: assessOf(null), now: () => now }, shipment, '563012345', emptyTelemetryState, {});
    expect(step.report).toEqual({ status: 'no-position', message: 'socket exploded' });
  });
});
