import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { startLocalActors } from 'durable-actors/dev';
import { createActorStub, createActorTransport } from 'durable-actors/backend';
import { demoShipments } from '../../../src/core/demo';
import type { Disruption, RelayOutcome, Shipment } from '../../../src/core/types';
import type { PortAgent } from '../../../src/server/agents/port/agent';
import type { ShipmentAgent } from '../../../src/server/agents/ship/agent';
import { attemptRelay } from '../../../src/server/relay/client';
import { createMonitoring } from '../../../src/server/runtime/monitoring';

test('provider failures are explicit results without leaking credentials', async () => {
  expect(await attemptRelay(() => Promise.reject(new Error('secret-provider-detail')), 'Relay unavailable')).toEqual({ status: 'unavailable', message: 'Relay unavailable' });
});

type PortClient = Pick<PortAgent, 'initialize' | 'simulate' | 'check'>;
type ShipmentClient = Pick<ShipmentAgent, 'initialize' | 'snapshot' | 'check'>;
type Actors = Readonly<{ port: PortClient; shipments: readonly ShipmentClient[] }>;
const workspaceId = process.env.GAZETTEER_RUNTIME_WORKSPACE ?? 'runtime-check-2';
const dataDir = process.env.GAZETTEER_RUNTIME_DATA_DIR ?? '.data/runtime-check';
const success = <A>(result: RelayOutcome<A>): A => {
  if (result.status === 'unavailable') throw new Error(result.message);
  return result.value;
};

async function withActors<A>(operation: (actors: Actors) => Promise<A>): Promise<A> {
  const runtime = await startLocalActors({
    project: resolve(import.meta.dir, '../../..'), projectId: 'gazetteer', entrypoint: 'src/server/agents/index.ts',
    dataDir, apiKey: randomUUID(), quiet: false,
  });
  await using cleanup = { [Symbol.asyncDispose]: () => runtime.stop() };
  const transport = createActorTransport({
    projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl,
    apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion,
  });
  return await operation({
    port: createActorStub<PortClient>('PortAgent', `${workspaceId}-port-singapore`, [
      { name: 'initialize', result: 'value' }, { name: 'simulate', result: 'void' }, { name: 'check', result: 'value' },
    ], transport),
    shipments: demoShipments().map(value => createActorStub<ShipmentClient>('ShipmentAgent', `${workspaceId}-shipment-${value.id}`, [
      { name: 'initialize', result: 'value' }, { name: 'snapshot', result: 'value' }, { name: 'check', result: 'value' },
    ], transport)),
  });
}

const snapshots = async (actors: Actors): Promise<readonly Shipment[]> => Promise.all(actors.shipments.map(async client => {
  const shipment = await client.snapshot();
  if (!shipment) throw new Error('Missing durable shipment');
  return shipment;
}));

async function waitForAlarm(read: () => Promise<readonly Shipment[]>, id: string, remaining = 20): Promise<readonly Shipment[]> {
  const state = await read();
  if (state.filter(value => value.appliedDisruptions.includes(id)).length === 2) return state;
  if (remaining === 0) throw new Error('Durable alarms did not deliver the queued disruption within 150 seconds');
  await Bun.sleep(5_000);
  return waitForAlarm(read, id, remaining - 1);
}

/** Opt in explicitly; reuses the configured Relay workspace and retained runtime-check actors. */
test.skipIf(process.env.GAZETTEER_RUNTIME_INTEGRATION !== '1')('real restart retains shipments/outbox; alarms deliver and replay remains idempotent', async () => {
  const key = process.env.RELAY_WORKSPACE_KEY;
  if (!key) throw new Error('Configure RELAY_WORKSPACE_KEY before running the provider integration test');
  const id = randomUUID();
  const disruption: Disruption = {
    id, portId: 'singapore', delayHours: 1,
    evidence: { id, source: 'simulation', title: 'Restart integration check', detail: 'Synthetic one-hour Singapore disruption for durable restart verification.', observedAt: new Date().toISOString() },
  };
  const before = await withActors(async actors => {
    success(await actors.port.initialize(workspaceId, 'singapore', key, true));
    await actors.shipments.reduce<Promise<void>>((previous, client, index) => previous.then(async () => {
      success(await client.initialize(workspaceId, demoShipments()[index]!, key));
    }), Promise.resolve());
    // Settle any retained event from a previous run before recording this run's baseline.
    success(await actors.port.check());
    await actors.shipments.reduce<Promise<void>>((previous, client) => previous.then(async () => { success(await client.check()); }), Promise.resolve());
    const state = await snapshots(actors);
    await actors.port.simulate(disruption);
    // No publication/check call: only the durable alarm may drain this queue after restart.
    return state;
  });
  const delivered = await (async () => {
    const monitoring = await createMonitoring({ dataDir, workspaceIds: [workspaceId] });
    await using cleanup = { [Symbol.asyncDispose]: () => monitoring.close() };
    const read = async (): Promise<readonly Shipment[]> => success(await monitoring.dashboard(workspaceId)).shipments;
    expect(await read()).toEqual(before);
    await Bun.sleep(50_000);
    return await waitForAlarm(read, id);
  })();
  expect(delivered.map((value, index) => value.delayHours - before[index]!.delayHours)).toEqual([1, 0, 1, 0]);
  expect(delivered.map((value, index) => Date.parse(value.eta) - Date.parse(before[index]!.eta))).toEqual([3_600_000, 0, 3_600_000, 0]);
  expect(delivered.filter(value => value.id === 'gz-1043' || value.id === 'gz-1045')).toEqual(before.filter(value => value.id === 'gz-1043' || value.id === 'gz-1045'));
  await withActors(async actors => {
    await actors.port.simulate(disruption);
    success(await actors.port.check());
    const replayed = await actors.shipments.reduce<Promise<readonly Shipment[]>>((previous, client) => previous.then(async state => [...state, success(await client.check())]), Promise.resolve([]));
    expect(replayed).toEqual(delivered);
    expect(replayed.filter(value => value.appliedDisruptions.includes(id)).every(value => value.evidence.filter(evidence => evidence.id === id).length === 1)).toBe(true);
  });
}, 240_000);
