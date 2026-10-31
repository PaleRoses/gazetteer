import { describe, expect, test } from 'bun:test';
import type { BoardMessage, EtaNotice, ShipObservation } from '../../../src/core/board';
import { demoShipments, ports } from '../../../src/core/demo';
import { distanceKm, voyageRoute } from '../../../src/core/routes';
import type { Shipment } from '../../../src/core/types';
import { assessPort } from '../../../src/server/agents/port/risk';
import { decideBoard, emptyBoardMemory } from '../../../src/server/agents/ship/board';
import { emptyTelemetryState, watchShipment } from '../../../src/server/agents/ship/watch';
import { observe } from '../../../src/server/telemetry/watcher';
import type { TelemetrySource } from '../../../src/server/telemetry/telemetry';
import { demoEnabled, demoScenarios, simulate, simulationSource, telemetryBinding, underway, type Scenario } from '../../../src/server/telemetry/simulation';

const created = new Date('2026-10-31T12:00:00.000Z');
const fleet: readonly Shipment[] = demoShipments(created);
const at = (hours: number): string => new Date(created.getTime() + hours * 3_600_000).toISOString();
const plan = (shipment: Shipment) => ({ route: voyageRoute(shipment) ?? shipment.route, eta: shipment.eta, ports: ports.map(({ name, coordinates }) => ({ name, coordinates })) });
const signalsOf = (shipment: Shipment, now: string, scenario: Scenario = demoScenarios[shipment.id] ?? underway): readonly string[] =>
  observe(plan(shipment), simulate(shipment, scenario, now), now).signals.map(signal => signal.kind);
const byId = (id: string): Shipment => fleet.find(shipment => shipment.id === id)!;
const anchoredIds = Object.entries(demoScenarios).filter(([, scenario]) => scenario.kind === 'anchored').map(([id]) => id);

describe('simulated telemetry', () => {
  test('is a pure function of shipment, scenario and time, and says what it is', () => {
    const ship = byId('gz-1048');
    const first = simulate(ship, underway, at(2));
    expect(simulate(ship, underway, at(2))).toEqual(first);
    expect(simulate(ship, underway, at(3)).position).not.toEqual(first.position);
    expect(first).toMatchObject({ provider: 'simulation', provenance: 'simulation', fetchedAt: at(2), observedAt: at(2) });
    expect(first.mmsi).toBe('sim:gz-1048');
  });

  test('the same fleet recreated after a restart yields the same telemetry', () => {
    const again = demoShipments(created);
    expect(fleet.map(ship => simulate(ship, demoScenarios[ship.id] ?? underway, at(5)))).toEqual(again.map(ship => simulate(ship, demoScenarios[ship.id] ?? underway, at(5))));
  });

  test('anchored ships sit 10 to 25 km off Singapore, stopped, and trip stationary-outside-port', () => {
    const singapore = ports.find(port => port.id === 'singapore')!.coordinates;
    expect(anchoredIds.length).toBeGreaterThanOrEqual(2);
    anchoredIds.forEach(id => {
      const ship = byId(id);
      const fix = simulate(ship, demoScenarios[id]!, at(1));
      const km = distanceKm(fix.position, singapore);
      expect(km).toBeGreaterThanOrEqual(10);
      expect(km).toBeLessThanOrEqual(25);
      expect(fix).toMatchObject({ sogKnots: 0.1, navStatus: 1 });
      expect(signalsOf(ship, at(1))).toEqual(['stationary-outside-port']);
    });
  });

  test('the moving ships raise nothing as the hours pass; the slow one and the dark one raise exactly their own signal', () => {
    const special = new Set([...anchoredIds, 'gz-1051', 'gz-1052']);
    const quiet = fleet.filter(ship => !special.has(ship.id));
    expect(quiet.length).toBeGreaterThanOrEqual(6);
    [0, 3, 12, 24].forEach(hours => quiet.forEach(ship => expect({ id: ship.id, hours, signals: signalsOf(ship, at(hours)) }).toEqual({ id: ship.id, hours, signals: [] })));
    [0, 6, 24].forEach(hours => {
      expect(signalsOf(byId('gz-1051'), at(hours))).toEqual(['slow-steaming']);
      expect(signalsOf(byId('gz-1052'), at(hours))).toEqual(['ais-dark']);
    });
  });

  test('the story sits where it says: the slow ship in the Indian Ocean, the dark one in the mid-Pacific', () => {
    const [slowLon] = simulate(byId('gz-1051'), demoScenarios['gz-1051']!, at(0)).position;
    expect(slowLon).toBeGreaterThan(40);
    expect(slowLon).toBeLessThan(100);
    const [darkLon, darkLat] = simulate(byId('gz-1052'), demoScenarios['gz-1052']!, at(0)).position;
    expect(Math.abs(darkLon)).toBeGreaterThan(160);
    expect(darkLat).toBeGreaterThan(25);
  });
});

describe('binding', () => {
  const real: TelemetrySource = async () => ({ status: 'unavailable', message: 'real feed' });
  const ship = byId('gz-1044');
  test('a real MMSI feed always wins; the scripted fleet stands in only without one and only while the demo is on', async () => {
    expect(telemetryBinding(ship, '563012345', true, real)).toEqual({ key: '563012345', source: real });
    const demo = telemetryBinding(ship, undefined, true, real, () => at(1))!;
    expect(demo.key).toBe('sim:gz-1044');
    expect(await demo.source(demo.key)).toMatchObject({ status: 'ok', value: { provider: 'simulation' } });
    expect(telemetryBinding(ship, undefined, false, real)).toBeNull();
    expect(demoEnabled({})).toBe(true);
    expect(demoEnabled({ GAZETTEER_DEMO: 'off' })).toBe(false);
    expect(demoEnabled({ GAZETTEER_DEMO: 'on' })).toBe(true);
  });
});

describe('the society from simulated observations', () => {
  const now = at(1);
  const board = async (scenarios: Readonly<Record<string, Scenario>>): Promise<readonly BoardMessage[]> =>
    (await Promise.all(fleet.map(async ship => {
      const step = await watchShipment({ source: simulationSource(ship, scenarios, () => now), assess: { model: null, modelId: 'none', now: () => now }, now: () => now }, ship, `sim:${ship.id}`, emptyTelemetryState, {});
      return decideBoard(emptyBoardMemory, { shipment: step.shipment, situation: step.state.situation, now }).map(item => item.message);
    }))).flat();
  const risk = (messages: readonly BoardMessage[], portId: 'singapore' | 'rotterdam' | 'shanghai' | 'los-angeles') => assessPort({
    portId, coordinates: ports.find(port => port.id === portId)!.coordinates, now: new Date(now), notices: [], previous: null,
    observations: messages.filter((message): message is ShipObservation => message.kind === 'ship.observation'),
    etas: messages.filter((message): message is EtaNotice => message.kind === 'ship.eta'),
  });

  test('ships posting stopped-outside-port observations lift Singapore; without them it falls', async () => {
    const story = await board(demoScenarios);
    const singapore = risk(story, 'singapore');
    expect(singapore.risk).toBe('severe');
    expect(singapore.anchoredShips.toSorted()).toEqual(anchoredIds.toSorted());
    const calm = risk(await board({}), 'singapore');
    expect(calm.anchored).toBe(0);
    expect(['normal', 'elevated']).toContain(calm.risk);
  });

  test('Rotterdam shows traffic, and the quiet ports stay normal', async () => {
    const story = await board(demoScenarios);
    expect(risk(story, 'rotterdam').risk).toBe('elevated');
    expect(risk(story, 'shanghai').risk).toBe('normal');
    expect(risk(story, 'los-angeles').risk).toBe('normal');
  });

  test('the dark and slow ships also speak on the board, labelled as simulation', async () => {
    const observations = (await board(demoScenarios)).filter((message): message is ShipObservation => message.kind === 'ship.observation');
    expect(observations.map(message => message.signals).flat().sort()).toEqual(['ais-dark', 'slow-steaming', 'stationary-outside-port', 'stationary-outside-port']);
    expect(new Set(observations.map(message => message.provider))).toEqual(new Set(['simulation']));
  });
});
