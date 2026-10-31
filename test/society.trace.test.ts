import { describe, expect, test } from 'bun:test';
import { citations, type BoardMessage, type TrafficReport, type ShipAssessment, type ShipObservation } from '../src/core/board';
import { demoShipments } from '../src/core/demo';
import { demoScenarios, underway } from '../src/server/telemetry/simulation';
import { cycles, runSociety, start } from './society-run';

const assessments = (board: readonly BoardMessage[]): readonly ShipAssessment[] => board.filter((message): message is ShipAssessment => message.kind === 'ship.assessment');
const bulletins = (board: readonly BoardMessage[]): readonly TrafficReport[] => board.filter((message): message is TrafficReport => message.kind === 'city.traffic');

/** Each test runs the whole society for an hour of simulated time; a loaded machine needs more than bun's 5 s. */
const patience = 120_000;

describe('the society on a fake clock, model off', () => {
  test('a queue at Singapore is heard by the ships behind it, in order, each citing what it heard', async () => {
    const { board, ships } = await runSociety();
    const observation = board.find(message => message.kind === 'ship.observation' && message.signals.includes('stationary-outside-port'));
    expect(observation).toBeDefined();
    const bulletin = bulletins(board).find(item => item.author.city === 'singapore' && item.risk !== 'normal' && item.evidenceIds.includes(observation!.id));
    expect(bulletin).toBeDefined();
    expect(board.indexOf(observation!)).toBeLessThan(board.indexOf(bulletin!));
    const listeners = assessments(board).filter(item => item.method === 'rule-based' && item.citedEvidence.includes(bulletin!.id) && item.shipmentId !== (observation as ShipObservation).shipmentId);
    expect(new Set(listeners.map(item => item.shipmentId)).size).toBeGreaterThanOrEqual(2);
    expect(listeners.every(item => item.confidence === null)).toBe(true);
    expect(bulletins(board).filter(item => item.author.city === 'singapore').some(item => item.risk === 'severe')).toBe(true);
    // Every cited board message exists, and every bulletin, rule-based assessment and revised ETA cites something.
    const ids = new Set(board.map(message => message.id));
    const boardIds = /^(traffic|obs|asm|eta):/;
    board.flatMap(citations).filter(id => boardIds.test(id)).forEach(id => expect(ids.has(id)).toBe(true));
    bulletins(board).filter(item => item.risk !== 'normal').forEach(item => expect(citations(item).length).toBeGreaterThan(0));
    assessments(board).filter(item => item.method === 'rule-based').forEach(item => expect(citations(item).length).toBeGreaterThan(0));
    board.filter(message => message.kind === 'ship.eta' && message.citedEvidence).forEach(message => expect(citations(message).length).toBeGreaterThan(0));
    expect(ships.size).toBeGreaterThan(0);
  }, patience);

  test('every ship message is spoken by the ship\'s own mind, and says so first', async () => {
    const { board, ships } = await runSociety();
    const spoken = board.filter(message => message.author.role === 'ship');
    expect(spoken.length).toBeGreaterThan(0);
    spoken.forEach(message => {
      const mind = message.author.role === 'ship' ? ships.get(message.author.id)!.shipment.agent : '';
      expect(message.author.role === 'ship' ? message.author.agent : undefined).toBe(mind);
      expect(message.summary.startsWith(`${mind}, aboard ${message.author.role === 'ship' ? message.author.vessel : ''}`)).toBe(true);
    });
  }, patience);

  test('what a ship posts, its risk, its method and its words, comes from one decision, and the last post is the ship\'s risk now', async () => {
    const { board, ships } = await runSociety();
    const posted = assessments(board);
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.filter(item => item.method === 'deterministic')).toEqual([]);
    posted.filter(item => item.method === 'rule-based').forEach(item => {
      expect(item.confidence).toBeNull();
      expect(item.summary).toContain('by rule');
      expect(citations(item).length).toBeGreaterThan(0);
    });
    for (const [id, state] of ships) {
      const last = posted.filter(item => item.shipmentId === id).at(-1);
      if (last) expect(last.risk).toBe(state.shipment.risk);
    }
  }, patience);

  test('the head of the queue is delayed by its own measured stop with its ETA untouched; the ship behind it is held by the queue ahead', async () => {
    const { board, ships } = await runSociety();
    const stops = board.filter((message): message is ShipObservation => message.kind === 'ship.observation' && message.signals.includes('stationary-outside-port'));
    const [head, ...behind] = stops.map(message => message.shipmentId);
    const original = new Map(demoShipments(new Date(start)).map(shipment => [shipment.id, shipment.eta]));
    expect(ships.get(head!)!.shipment.risk).not.toBe('on-track');
    expect(ships.get(head!)!.shipment.eta).toBe(original.get(head!)!);
    expect(behind.length).toBeGreaterThan(0);
    behind.forEach(id => expect(Date.parse(ships.get(id!)!.shipment.eta)).toBeGreaterThan(Date.parse(original.get(id!)!)));
  }, patience);

  test('the longest-waiting veteran (20 h at anchor, its ETA already past) is the head of the queue and waits for no one', async () => {
    const template = demoShipments(new Date(start)).find(item => item.destination === 'singapore' && demoScenarios[item.id]?.kind === 'queue')!;
    const shift = (at: string): string => new Date(Date.parse(at) - (Date.parse(template.baselineEta) - (start - 20 * 3_600_000))).toISOString();
    const veteran = { ...template, id: 'gz-veteran', agent: 'Zz', baselineEta: shift(template.baselineEta), eta: shift(template.eta), milestones: template.milestones.map(milestone => ({ ...milestone, at: shift(milestone.at) })) };
    const { board, ships } = await runSociety(() => ({ ...demoScenarios, 'gz-veteran': { kind: 'queue', offsetKm: 16, bearingDegrees: 120, holdHours: 40 } }), [veteran]);
    expect(board.some(message => message.kind === 'city.traffic' && message.anchored >= 3)).toBe(true);
    expect(ships.get('gz-veteran')!.shipment.eta).toBe(veteran.eta);
  }, patience);

  test('a ship that leaves the queue says so, and the port stops counting it', async () => {
    const queue = Object.keys(demoScenarios).filter(id => demoScenarios[id]!.kind === 'queue');
    const leaves = (cycle: number) => cycle < cycles * 3 / 4 ? demoScenarios : { ...demoScenarios, ...Object.fromEntries(queue.map(id => [id, underway])) };
    const { board, ships } = await runSociety(leaves);
    const singapore = bulletins(board).filter(item => item.author.city === 'singapore');
    expect(Math.max(...singapore.map(item => item.anchored))).toBeGreaterThanOrEqual(2);
    expect(singapore[singapore.length - 1]!.anchored).toBe(0);
    expect(board.some(message => message.kind === 'ship.observation' && message.signals.length === 0)).toBe(true);
    const original = new Map(demoShipments(new Date(start)).map(shipment => [shipment.id, shipment.eta]));
    expect(ships.get('gz-1047')!.shipment.eta).toBe(original.get('gz-1047')!);
  }, patience);

  test('when the signals clear, a ship returns to the risk it was assessed at', async () => {
    const troubled = await runSociety(cycle => cycle < cycles / 2 ? demoScenarios : { ...demoScenarios, 'gz-1051': underway, 'gz-1052': underway });
    const hobbled = await runSociety(() => demoScenarios);
    expect(hobbled.ships.get('gz-1052')!.shipment.risk).toBe('watch');
    expect(troubled.ships.get('gz-1052')!.shipment.risk).toBe('on-track');
  }, patience);
});

