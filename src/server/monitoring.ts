import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { startLocalActors } from 'durable-actors/dev';
import { createActorStub, createActorTransport, type ActorRpcMethod } from 'durable-actors/backend';
import { demoShipments, ports } from '../domain';
import type { Dashboard, Disruption, PortId, Shipment } from '../shared';
import type { PortAgent, ShipmentAgent } from './actors';

type PortClient = Pick<PortAgent, 'initialize' | 'simulate' | 'check'>;
type ShipmentClient = Pick<ShipmentAgent, 'initialize' | 'snapshot' | 'check'>;
const portMethods = [
  { name: 'initialize', result: 'void' }, { name: 'simulate', result: 'void' }, { name: 'check', result: 'void' },
] satisfies readonly (ActorRpcMethod & { name: keyof PortClient })[];
const shipmentMethods = [
  { name: 'initialize', result: 'void' }, { name: 'snapshot', result: 'value' }, { name: 'check', result: 'value' },
] satisfies readonly (ActorRpcMethod & { name: keyof ShipmentClient })[];

export type Monitoring = Readonly<{
  dashboard(workspaceId: string): Promise<Dashboard>;
  simulate(workspaceId: string, portId: PortId, delayHours: number): Promise<Dashboard>;
  close(): Promise<void>;
}>;

export async function createMonitoring(options: { dataDir?: string } = {}): Promise<Monitoring> {
  const workspaceKey = process.env.RELAY_WORKSPACE_KEY;
  if (!workspaceKey) throw new Error('Agent Relay is not configured. Run npm run setup:relay first.');
  const project = resolve(import.meta.dir, '../..');
  const dataDir = resolve(project, options.dataDir ?? resolve(process.env.DATA_DIR ?? '.data', 'actors'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const runtime = await startLocalActors({
    project, projectId: 'gazetteer', entrypoint: 'src/server/actors.ts',
    dataDir, apiKey: randomUUID(), quiet: true,
  });
  const transport = createActorTransport({
    projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl,
    apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion,
  });
  const port = (workspaceId: string, id: PortId): PortClient => createActorStub<PortClient>('PortAgent', `${workspaceId}-port-${id}`, portMethods, transport);
  const shipment = (workspaceId: string, id: string): ShipmentClient => createActorStub<ShipmentClient>('ShipmentAgent', `${workspaceId}-shipment-${id}`, shipmentMethods, transport);

  const initialize = async (workspaceId: string): Promise<readonly Shipment[]> => {
    const seeds = demoShipments();
    await port(workspaceId, 'singapore').initialize(workspaceId, 'singapore', workspaceKey, true);
    await ports.filter(value => value.id !== 'singapore').reduce<Promise<void>>((previous, value) => previous.then(() => port(workspaceId, value.id).initialize(workspaceId, value.id, workspaceKey, false)), Promise.resolve());
    await seeds.reduce<Promise<void>>((previous, value) => previous.then(() => shipment(workspaceId, value.id).initialize(workspaceId, value, workspaceKey)), Promise.resolve());
    return seeds;
  };
  const dashboard = async (workspaceId: string): Promise<Dashboard> => {
    const seeds = await initialize(workspaceId);
    const snapshots = await Promise.all(seeds.map(value => shipment(workspaceId, value.id).snapshot()));
    return {
      shipments: snapshots.filter((value): value is Shipment => value !== null), ports,
      updatedAt: new Date().toISOString(), mode: 'simulation',
      runtime: 'Terse Durable Actors · retained state', relay: 'Agent Relay · synthetic disruptions only',
    };
  };
  return {
    dashboard,
    simulate: async (workspaceId, portId, delayHours) => {
      const seeds = await initialize(workspaceId);
      const id = randomUUID();
      const disruption: Disruption = {
        id, portId, delayHours,
        evidence: { id, source: 'simulation', title: 'Simulated port congestion', detail: `Synthetic terminal bulletin: a ${delayHours}-hour berth delay at ${ports.find(value => value.id === portId)?.name ?? portId}. Deterministic demo assessment; not live intelligence.`, observedAt: new Date().toISOString() },
      };
      await port(workspaceId, portId).simulate(disruption);
      await Promise.all(seeds.map(value => shipment(workspaceId, value.id).check()));
      return dashboard(workspaceId);
    },
    close: () => runtime.stop(),
  };
}
