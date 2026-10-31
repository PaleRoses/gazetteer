import { ports } from '../../../core/demo';
import { voyageRoute } from '../../../core/routes';
import { assessTelemetry, type AssessDeps, type AssessmentCache, type AssessmentOutcome } from '../../assessment/assess';
import type { AssessedShipment } from '../../assessment/apply';
import type { BoardEvidence } from '../../assessment/prompt';
import { describeError, type Telemetry, type TelemetrySource } from '../../telemetry/telemetry';
import { emptyTrack, type Track } from '../../telemetry/gfw';
import { defaultThresholds, nextSituation, observe, type Situation, type Thresholds } from '../../telemetry/watcher';

export type TelemetryState = Readonly<{ latest: Telemetry | null; situation: Situation | null; track?: Track }>;
export const emptyTelemetryState: TelemetryState = { latest: null, situation: null, track: emptyTrack };
export type WatchDeps = Readonly<{ source: TelemetrySource; assess: AssessDeps; board?: readonly BoardEvidence[]; thresholds?: Thresholds; now?: () => string }>;
export type WatchReport =
  | Readonly<{ status: 'untracked' }>
  | Readonly<{ status: 'no-position'; message: string }>
  | Readonly<{ status: 'watched'; fetch: 'fresh' | 'stale'; fetchMessage: string | null; signals: number; assessment: AssessmentOutcome | null }>;
export type WatchStep = Readonly<{ shipment: AssessedShipment; state: TelemetryState; cache: AssessmentCache; report: WatchReport }>;

const newer = (a: Telemetry | null, b: Telemetry): Telemetry => a && Date.parse(a.observedAt) > Date.parse(b.observedAt) ? a : b;

/** One watch cycle on the ship's existing alarm: fetch, observe, track the situation, ask the assessor once per situation. Total: failures are data. */
export async function watchShipment(deps: WatchDeps, shipment: AssessedShipment, mmsi: string | null, state: TelemetryState, cache: AssessmentCache): Promise<WatchStep> {
  if (!mmsi) return { shipment, state, cache, report: { status: 'untracked' } };
  const now = (deps.now ?? (() => new Date().toISOString()))();
  const fetched = await deps.source(mmsi).catch((error: unknown) => ({ status: 'unavailable' as const, message: describeError(error) }));
  const latest = fetched.status === 'ok' ? newer(state.latest, fetched.value) : state.latest;
  if (!latest) return { shipment, state, cache, report: { status: 'no-position', message: fetched.status === 'unavailable' ? fetched.message : 'no position' } };
  const plan = { route: voyageRoute(shipment) ?? shipment.route, eta: shipment.eta, ports: ports.map(({ name, coordinates }) => ({ name, coordinates })) };
  const observation = observe(plan, latest, now, deps.thresholds ?? defaultThresholds, state.track ?? emptyTrack);
  const situation = nextSituation(state.situation, observation.signals, shipment.id, now);
  const watched: AssessedShipment = { ...shipment, telemetry: latest, signals: observation.signals };
  const nextState: TelemetryState = { latest, situation, track: observation.track };
  const report = (assessment: AssessmentOutcome | null): WatchReport => ({
    status: 'watched', fetch: fetched.status === 'ok' ? 'fresh' : 'stale', fetchMessage: fetched.status === 'unavailable' ? fetched.message : null, signals: observation.signals.length, assessment,
  });
  if (!situation) return { shipment: watched, state: nextState, cache, report: report(null) };
  const settled = await assessTelemetry(deps.assess, cache, watched, situation, observation, deps.board ?? []);
  return { shipment: settled.shipment, state: nextState, cache: settled.cache, report: report(settled.outcome) };
}
