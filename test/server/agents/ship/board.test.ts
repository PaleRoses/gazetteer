import { describe, expect, test } from 'bun:test';
import { parseBoardMessage, type BoardMessage, type TrafficReport, type ShipObservation } from '../../../../src/core/board';
import { demoShipments } from '../../../../src/core/demo';
import { positionAlong, voyageRoute } from '../../../../src/core/routes';
import type { RelayOutcome } from '../../../../src/core/types';
import { applyAssessment, applyFallback, type AssessedShipment } from '../../../../src/server/assessment/apply';
import { assessNotice } from '../../../../src/server/assessment/assess';
import type { AssessableNotice } from '../../../../src/server/assessment/exposure';
import type { Assessment } from '../../../../src/server/assessment/schema';
import { commitDecisions, decideBoard, emptyBoardMemory, rememberBoard, selectBoardEvidence, type Outbound, type ShipBoardMemory } from '../../../../src/server/agents/ship/board';
import type { Situation } from '../../../../src/server/telemetry/watcher';
import type { Telemetry } from '../../../../src/server/telemetry/telemetry';
const now = '2026-10-31T12:00:00.000Z';
const [meridian, laurel] = demoShipments(new Date(now)) as [AssessedShipment, AssessedShipment, ...AssessedShipment[]];
const telemetry: Telemetry = { mmsi: '563012345', position: [103.9, 1.3], sogKnots: 0, cogDegrees: 90, navStatus: 1, observedAt: now, provenance: 'live', provider: 'aisstream', fetchedAt: now };
const situation: Situation = { id: 'telemetry:gz-1042:stationary-outside-port:t1', kinds: ['stationary-outside-port'], startedAt: now };
const signal = { id: '563012345:stationary-outside-port:t', kind: 'stationary-outside-port' as const, title: 'Vessel stopped outside port', detail: '', observedAt: now, provenance: 'live' as const, provider: 'aisstream' as const, fetchedAt: now, measured: {}, thresholds: {}, telemetry };
const watched: AssessedShipment = { ...meridian, telemetry, signals: [signal] };
const apply = (memory: ShipBoardMemory, outbound: readonly Outbound[]): ShipBoardMemory => outbound.reduce((current, item) => item.remember(current), memory);
const kinds = (outbound: readonly Outbound[]): readonly string[] => outbound.map(item => item.message.kind);

const notice: AssessableNotice = { id: 'sg-1', portId: 'singapore', delayHours: 36, evidence: { id: 'sg-1', source: 'simulation', title: 'Berth congestion', detail: 'Simulated.', observedAt: now } };
const verdict = (cited: readonly string[]): Assessment => ({ affected: true, delayHours: { low: 20, likely: 30, high: 50 }, risk: 'delayed', rationale: 'Queue at the next call.', citedEvidence: [...cited], confidence: 0.6, action: null });
const delayed = applyAssessment(meridian, notice, { assessment: verdict(['sg-1']), model: 'test-model', assessedAt: now });

describe('ship evidence from the city watches', () => {
  test('the newest traffic and hazard report of a port still ahead are evidence, with their element; a port behind is not', () => {
    const traffic = (id: string, at: string, city: 'singapore' | 'shanghai'): BoardMessage => ({ id, kind: 'city.traffic', author: { role: 'city', city, element: 'traffic' }, at, summary: 's', risk: 'severe', anchored: 4, arrivals48h: 1, evidenceIds: [], basis: { perHour: 0.8, provenance: 'assumed', basis: 'b' } });
    const hazard: BoardMessage = { id: 'h1', kind: 'city.hazards', author: { role: 'city', city: 'singapore', element: 'hazards' }, at: now, summary: 's', risk: 'elevated', notices: [], evidenceIds: [] };
    const board = [traffic('t-old', '2026-10-31T10:00:00.000Z', 'singapore'), traffic('t-new', '2026-10-31T11:00:00.000Z', 'singapore'), traffic('t-behind', now, 'shanghai'), hazard];
    const evidence = selectBoardEvidence(meridian, board, now);
    expect(evidence.map(item => item.id).sort()).toEqual(['h1', 't-new']);
    expect(evidence.find(item => item.id === 't-new')).toMatchObject({ kind: 'city.traffic', facts: { portId: 'singapore', element: 'traffic', anchored: 4 } });
  });
});

describe('ship board decisions', () => {
  test('a fresh ship announces its ETA to each port ahead, once; every message is valid board traffic', () => {
    const first = decideBoard(emptyBoardMemory, { shipment: meridian, situation: null, now });
    expect(first.map(item => item.message.id)).toEqual(['eta:gz-1042:singapore:' + meridian.milestones[1]!.at, 'eta:gz-1042:rotterdam:' + meridian.eta]);
    expect(first.every(item => parseBoardMessage(item.message) !== undefined)).toBe(true);
    expect(first.map(item => item.message.id)).toEqual(decideBoard(emptyBoardMemory, { shipment: meridian, situation: null, now }).map(item => item.message.id));
    expect(decideBoard(apply(emptyBoardMemory, first), { shipment: meridian, situation: null, now })).toEqual([]);
  });

  test('an observation is posted when a situation starts or changes, and never repeats', () => {
    const memory = apply(emptyBoardMemory, decideBoard(emptyBoardMemory, { shipment: watched, situation: null, now }));
    const started = decideBoard(memory, { shipment: watched, situation, now });
    expect(kinds(started)).toEqual(['ship.observation']);
    const observation = started[0]!.message as ShipObservation;
    expect(observation).toMatchObject({ id: `obs:${situation.id}`, shipmentId: 'gz-1042', signals: ['stationary-outside-port'], nearPort: 'singapore', provider: 'aisstream', observedAt: now, author: { role: 'ship', id: 'gz-1042' } });
    expect(parseBoardMessage(observation)).toBeDefined();
    const remembered = apply(memory, started);
    expect(decideBoard(remembered, { shipment: watched, situation, now })).toEqual([]);
    const widened: Situation = { ...situation, id: 'telemetry:gz-1042:ais-dark+stationary-outside-port:t2', kinds: ['ais-dark', 'stationary-outside-port'] };
    expect(kinds(decideBoard(remembered, { shipment: watched, situation: widened, now }))).toEqual(['ship.observation']);
    const cleared = decideBoard(remembered, { shipment: watched, situation: null, now });
    expect(cleared.map(item => item.message)).toEqual([expect.objectContaining({ kind: 'ship.observation', id: `obs:cleared:${situation.id}`, signals: [] })]);
    expect(parseBoardMessage(cleared[0]!.message)).toBeDefined();
    expect(decideBoard(apply(remembered, cleared), { shipment: watched, situation: null, now })).toEqual([]);
  });

  test('an arithmetic fallback is posted as a rule-based assessment that the board accepts, never as a method of its own', () => {
    const fallback = applyFallback(meridian, notice, 'no model API key configured', now);
    expect(fallback.assessments?.[0]?.method).toBe('deterministic-fallback');
    const memory = apply(emptyBoardMemory, decideBoard(emptyBoardMemory, { shipment: meridian, situation: null, now }));
    const posted = decideBoard(memory, { shipment: fallback, situation: null, now }).map(item => item.message).filter(message => message.kind === 'ship.assessment');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ method: 'rule-based', confidence: null, citedEvidence: [notice.id], delayHours: { likely: 36 } });
    expect(parseBoardMessage(posted[0])).toBeDefined();
    expect(posted[0]!.summary).toContain('Deterministic fallback');
  });

  test('a changed risk or ETA posts one assessment and an ETA notice per port ahead, with the right previous ETA', () => {
    const memory = apply(emptyBoardMemory, decideBoard(emptyBoardMemory, { shipment: meridian, situation: null, now }));
    const out = decideBoard(memory, { shipment: delayed, situation: null, now });
    expect(kinds(out)).toEqual(['ship.assessment', 'ship.eta', 'ship.eta']);
    expect(out[0]!.message).toMatchObject({ risk: 'delayed', eta: delayed.eta, method: 'ai-assessed', confidence: 0.6, citedEvidence: ['sg-1'], delayHours: { low: 20, likely: 30, high: 50 }, ports: ['singapore', 'rotterdam'] });
    const etas = out.slice(1).map(item => item.message);
    expect(etas).toEqual([
      expect.objectContaining({ portId: 'singapore', previousEta: meridian.milestones[1]!.at, eta: delayed.milestones[1]!.at }),
      expect.objectContaining({ portId: 'rotterdam', previousEta: meridian.eta, eta: delayed.eta }),
    ]);
    expect(out.every(item => parseBoardMessage(item.message) !== undefined)).toBe(true);
    expect(decideBoard(apply(memory, out), { shipment: delayed, situation: null, now })).toEqual([]);
  });

  test('a transshipment already reached is no longer announced', () => {
    const reached: AssessedShipment = { ...meridian, milestones: meridian.milestones.map(item => item.label === 'Transshipment berth' ? { ...item, status: 'complete' as const } : item) };
    expect(decideBoard(emptyBoardMemory, { shipment: reached, situation: null, now }).map(item => (item.message as { portId?: string }).portId)).toEqual(['rotterdam']);
  });
});

describe('deciding', () => {
  const fresh = (): readonly Outbound[] => decideBoard(emptyBoardMemory, { shipment: delayed, situation: null, now });

  test('committing advances the memory at once, so the same facts are never decided twice, and hands over the messages in order', () => {
    const first = commitDecisions(emptyBoardMemory, fresh());
    expect(first.messages.map(message => message.kind)).toEqual(['ship.assessment', 'ship.eta', 'ship.eta']);
    expect(decideBoard(first.memory, { shipment: delayed, situation: null, now })).toEqual([]);
  });
});

describe('board evidence for the assessment', () => {
  const bulletin = (id: string, city: TrafficReport['author']['city'], at = now): TrafficReport => ({ id, kind: 'city.traffic', author: { role: 'city', city, element: 'traffic' }, at, summary: `${city} elevated`, risk: 'elevated', anchored: 3, arrivals48h: 7, evidenceIds: [], basis: { perHour: 0.8, provenance: 'assumed', basis: 'declared' } });
  const peer = (id: string, shipmentId: string, position: readonly [number, number], at = now): ShipObservation => ({
    id, kind: 'ship.observation', author: { role: 'ship', id: shipmentId, vessel: 'Peer' }, at, summary: 'Peer stopped', shipmentId, signals: ['stationary-outside-port'], position: [position[0], position[1]], nearPort: null, provider: 'digitraffic', observedAt: at,
  });
  const onRoute = positionAlong(voyageRoute(meridian)!, 0.5)!;
  const board: readonly BoardMessage[] = [
    bulletin('b-singapore', 'singapore'), bulletin('b-singapore-old', 'singapore', '2026-10-31T09:00:00.000Z'), bulletin('b-la', 'los-angeles'), bulletin('b-stale', 'rotterdam', '2026-10-29T09:00:00.000Z'),
    peer('p-near', 'gz-9', onRoute), peer('p-far', 'gz-8', [-150, -60]), peer('p-self', 'gz-1042', onRoute), peer('p-old', 'gz-7', onRoute, '2026-10-29T09:00:00.000Z'),
  ];

  test('only bulletins for ports ahead and fresh peers near the route are evidence, newest bulletin per port', () => {
    const ids = selectBoardEvidence(meridian, board, now).map(item => item.id);
    expect(ids).toEqual(['b-singapore', 'p-near']);
  });

  test('the model may cite a board message by id, and an invented board id is rejected', async () => {
    const evidence = selectBoardEvidence(meridian, board, now);
    const prompts: string[] = [];
    const modelFor = (cited: readonly string[]) => async ({ prompt }: { prompt: string }) => { prompts.push(prompt); return { status: 'ok' as const, output: verdict(cited) }; };
    const deps = (cited: readonly string[]) => ({ model: modelFor(cited), modelId: 'test-model', now: () => now });
    const good = await assessNotice(deps(['sg-1', 'b-singapore']), {}, meridian, notice, evidence);
    expect(good.outcome).toMatchObject({ status: 'assessed' });
    expect(good.shipment.assessments?.[0]?.citedEvidence).toEqual(['sg-1', 'b-singapore']);
    const sent = JSON.parse(prompts[0]!) as { board: { id: string; source: string }[] };
    expect(sent.board.map(item => item.id)).toEqual(['b-singapore', 'p-near']);
    expect(sent.board[0]!.source).toBe('agent-board');
    const bad = await assessNotice(deps(['b-la']), {}, meridian, notice, evidence);
    expect(bad.outcome).toMatchObject({ status: 'fallback', reason: expect.stringContaining('b-la') });
    const without = await assessNotice(deps(['b-singapore']), {}, laurel, { ...notice, portId: 'singapore' }, []);
    expect(without.outcome).toEqual({ status: 'skipped', reason: 'not-exposed' });
  });
});

describe('remembering the board', () => {
  const message = (id: string, at: string): BoardMessage => ({ id, kind: 'city.traffic', author: { role: 'city', city: 'singapore', element: 'traffic' }, at, summary: id, risk: 'normal', anchored: 0, arrivals48h: 0, evidenceIds: [], basis: { perHour: 0.8, provenance: 'assumed', basis: 'declared' } });
  test('deduplicates by id, drops what is past the horizon, and stays bounded', () => {
    const kept = rememberBoard([message('a', '2026-10-31T10:00:00.000Z'), message('old', '2026-10-29T10:00:00.000Z')], [message('a', '2026-10-31T10:00:00.000Z'), message('b', '2026-10-31T11:00:00.000Z')], now);
    expect(kept.map(item => item.id)).toEqual(['a', 'b']);
    const many = Array.from({ length: 80 }, (_, i) => message(`m${i}`, new Date(Date.parse(now) - (80 - i) * 60_000).toISOString()));
    const bounded = rememberBoard([], many, now);
    expect(bounded).toHaveLength(50);
    expect(bounded[49]!.id).toBe('m79');
  });
  test('a ship\'s latest stop outlives a flood of newer messages, but only its latest', () => {
    const stop = (id: string, at: string): BoardMessage => ({ id, kind: 'ship.observation', author: { role: 'ship', id: 'gz-9', vessel: 'v' }, at, summary: id, shipmentId: 'gz-9', signals: ['stationary-outside-port'], position: [0, 0], nearPort: null, provider: 'p', observedAt: at });
    const flood = Array.from({ length: 80 }, (_, i) => message(`m${i}`, new Date(Date.parse(now) - (80 - i) * 60_000).toISOString()));
    const kept = rememberBoard([], [stop('older', '2026-10-31T01:00:00.000Z'), stop('latest', '2026-10-31T02:00:00.000Z'), ...flood], now).map(item => item.id);
    expect(kept).toContain('latest');
    expect(kept).not.toContain('older');
  });
});
