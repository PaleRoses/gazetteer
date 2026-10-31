import { describe, expect, test } from 'bun:test';
import { citations, type BoardMessage, type PortBulletin, type ShipAssessment, type ShipObservation } from '../src/core/board';
import { demoShipments } from '../src/core/demo';
import { demoScenarios, underway } from '../src/server/telemetry/simulation';
import { cycles, runSociety, start } from './society-run';

const assessments = (board: readonly BoardMessage[]): readonly ShipAssessment[] => board.filter((message): message is ShipAssessment => message.kind === 'ship.assessment');
const bulletins = (board: readonly BoardMessage[]): readonly PortBulletin[] => board.filter((message): message is PortBulletin => message.kind === 'port.bulletin');

describe('the society on a fake clock, model off', () => {
  test('a queue at Singapore is heard by the ships behind it, in order, each citing what it heard', async () => {
    const { board, ships } = await runSociety();
    const observation = board.find(message => message.kind === 'ship.observation' && message.signals.includes('stationary-outside-port'));
    expect(observation).toBeDefined();
    const bulletin = bulletins(board).find(item => item.portId === 'singapore' && item.risk !== 'normal' && item.evidenceIds.includes(observation!.id));
    expect(bulletin).toBeDefined();
    expect(board.indexOf(observation!)).toBeLessThan(board.indexOf(bulletin!));
    const listeners = assessments(board).filter(item => item.method === 'rule-based' && item.citedEvidence.includes(bulletin!.id) && item.shipmentId !== (observation as ShipObservation).shipmentId);
    expect(new Set(listeners.map(item => item.shipmentId)).size).toBeGreaterThanOrEqual(2);
    expect(listeners.every(item => item.confidence === null)).toBe(true);
    expect(bulletins(board).filter(item => item.portId === 'singapore').some(item => item.risk === 'severe')).toBe(true);
    // Every cited board message exists, and every bulletin, rule-based assessment and revised ETA cites something.
    const ids = new Set(board.map(message => message.id));
    const boardIds = /^(bulletin|obs|asm|eta):/;
    board.flatMap(citations).filter(id => boardIds.test(id)).forEach(id => expect(ids.has(id)).toBe(true));
    bulletins(board).filter(item => item.risk !== 'normal').forEach(item => expect(citations(item).length).toBeGreaterThan(0));
    assessments(board).filter(item => item.method === 'rule-based').forEach(item => expect(citations(item).length).toBeGreaterThan(0));
    board.filter(message => message.kind === 'ship.eta' && message.citedEvidence).forEach(message => expect(citations(message).length).toBeGreaterThan(0));
    expect(ships.size).toBeGreaterThan(0);
  });

  test('every ship message is spoken by the ship\'s own mind, and says so first', async () => {
    const { board, ships } = await runSociety();
    const spoken = board.filter(message => message.author.role === 'ship');
    expect(spoken.length).toBeGreaterThan(0);
    spoken.forEach(message => {
      const mind = message.author.role === 'ship' ? ships.get(message.author.id)!.shipment.agent : '';
      expect(message.author.role === 'ship' ? message.author.agent : undefined).toBe(mind);
      expect(message.summary.startsWith(`${mind}, aboard ${message.author.role === 'ship' ? message.author.vessel : ''}`)).toBe(true);
    });
  });

  test('the head of the queue is delayed by its own measured stop with its ETA untouched; the ship behind it is held by the queue ahead', async () => {
    const { board, ships } = await runSociety();
    const stops = board.filter((message): message is ShipObservation => message.kind === 'ship.observation' && message.signals.includes('stationary-outside-port'));
    const [head, ...behind] = stops.map(message => message.shipmentId);
    const original = new Map(demoShipments(new Date(start)).map(shipment => [shipment.id, shipment.eta]));
    expect(ships.get(head!)!.shipment.risk).not.toBe('on-track');
    expect(ships.get(head!)!.shipment.eta).toBe(original.get(head!)!);
    expect(behind.length).toBeGreaterThan(0);
    behind.forEach(id => expect(Date.parse(ships.get(id!)!.shipment.eta)).toBeGreaterThan(Date.parse(original.get(id!)!)));
  });

  test('a ship that leaves the queue says so, and the port stops counting it', async () => {
    const queue = Object.keys(demoScenarios).filter(id => demoScenarios[id]!.kind === 'queue');
    const leaves = (cycle: number) => cycle < cycles * 3 / 4 ? demoScenarios : { ...demoScenarios, ...Object.fromEntries(queue.map(id => [id, underway])) };
    const { board, ships } = await runSociety(leaves);
    const singapore = bulletins(board).filter(item => item.portId === 'singapore');
    expect(Math.max(...singapore.map(item => item.anchored))).toBeGreaterThanOrEqual(2);
    expect(singapore[singapore.length - 1]!.anchored).toBe(0);
    expect(board.some(message => message.kind === 'ship.observation' && message.signals.length === 0)).toBe(true);
    const original = new Map(demoShipments(new Date(start)).map(shipment => [shipment.id, shipment.eta]));
    expect(ships.get('gz-1047')!.shipment.eta).toBe(original.get('gz-1047')!);
  });

  test('when the signals clear, a ship returns to the risk it was assessed at', async () => {
    const troubled = await runSociety(cycle => cycle < cycles / 2 ? demoScenarios : { ...demoScenarios, 'gz-1051': underway, 'gz-1052': underway });
    const hobbled = await runSociety(() => demoScenarios);
    expect(hobbled.ships.get('gz-1052')!.shipment.risk).toBe('watch');
    expect(troubled.ships.get('gz-1052')!.shipment.risk).toBe('on-track');
  });
});

