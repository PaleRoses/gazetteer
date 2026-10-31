import { type BoardMessage } from '../src/core/board';
import { demoShipments } from '../src/core/demo';
import { portById, type PortId } from '../src/core/ports';
import { relaySuccess, type Shipment } from '../src/core/types';
import { emptyTrafficMemory, watchTraffic, type BoardIo, type TrafficMemory } from '../src/server/agents/city/traffic';
import { think, type Thoughts } from '../src/server/agents/ship/think';
import { demoScenarios, simulationSource, type Scenario } from '../src/server/telemetry/simulation';

/** The society with no network and no model: a fake clock, one in-memory board with the real read-since-cursor semantics, 60 simulated minutes at 60 s cycles. */
export const start = Date.parse('2026-10-31T12:00:00.000Z');
const cycleSeconds = 60;
export const cycles = 60;
const clockAt = (cycle: number): string => new Date(start + cycle * cycleSeconds * 1000).toISOString();

export type Run = Readonly<{ board: readonly BoardMessage[]; ships: ReadonlyMap<string, Thoughts> }>;

export async function runSociety(scenarios: (cycle: number) => Readonly<Record<string, Scenario>> = () => demoScenarios, extra: readonly Shipment[] = []): Promise<Run> {
  const board: BoardMessage[] = [];
  const post = (message: BoardMessage): void => { if (!board.some(known => known.id === message.id)) board.push(message); };
  const fleet = [...demoShipments(new Date(start)), ...extra];
  let ships = new Map<string, Thoughts>(fleet.map(shipment => [shipment.id, { shipment }]));
  const shipCursor = new Map<string, number>();
  const portCursor = new Map<PortId, number>();
  let clock = clockAt(0);
  const portIds = [...new Set(fleet.flatMap(shipment => [shipment.destination, ...shipment.via]))];
  const memories = new Map<PortId, TrafficMemory>(portIds.map(id => [id, emptyTrafficMemory]));
  const io = (id: PortId): BoardIo => ({
    read: async () => { const from = portCursor.get(id) ?? 0; portCursor.set(id, board.length); return relaySuccess({ messages: board.slice(from), cursor: null }); },
    post: async (_, message) => { post(message); return relaySuccess(message.id); },
  });
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    clock = clockAt(cycle);
    const visible = board.length;
    const next = new Map(ships);
    for (const [id, state] of ships) {
      const from = shipCursor.get(id) ?? 0;
      shipCursor.set(id, visible);
      const thought = await think(
        { assess: { model: null, modelId: 'off', now: () => clock }, binding: shipment => ({ key: `sim:${shipment.id}`, source: simulationSource(shipment, scenarios(cycle), () => clock) }) },
        state, { board: board.slice(from, visible), disruptions: [], cursor: null }, clock);
      thought.messages.forEach(post);
      next.set(id, thought.state);
    }
    ships = next;
    for (const id of portIds) {
      const port = portById.get(id)!;
      const step = await watchTraffic(io(id), { token: 't', channel: 'c' }, memories.get(id)!, { city: id, coordinates: port.coordinates, now: new Date(clock) });
      memories.set(id, step.memory);
    }
  }
  return { board, ships };
}

