import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { startLocalActors } from 'durable-actors/dev';
import { createActorStub, createActorTransport, type ActorRpcMethod } from 'durable-actors/backend';
import { demoShipments, ports } from '../domain';
import { relaySuccess, type Dashboard, type Disruption, type PortId, type RelayOutcome, type Shipment } from '../shared';
import type { PortAgent, ShipmentAgent } from './actors';

type PortClient = Pick<PortAgent, 'initialize' | 'simulate' | 'check' | 'resume'>;
type ShipmentClient = Pick<ShipmentAgent, 'initialize' | 'snapshot' | 'check' | 'resume'>;
const portMethods = [
  { name: 'initialize', result: 'value' }, { name: 'simulate', result: 'void' }, { name: 'check', result: 'value' },
  { name: 'resume', result: 'void' },
] satisfies readonly (ActorRpcMethod & { name: keyof PortClient })[];
const shipmentMethods = [
  { name: 'initialize', result: 'value' }, { name: 'snapshot', result: 'value' }, { name: 'check', result: 'value' },
  { name: 'resume', result: 'void' },
] satisfies readonly (ActorRpcMethod & { name: keyof ShipmentClient })[];

export type Monitoring = Readonly<{
  dashboard(workspaceId: string): Promise<RelayOutcome<Dashboard>>;
  simulate(workspaceId: string, portId: PortId, delayHours: number): Promise<RelayOutcome<Dashboard>>;
  close(): Promise<void>;
}>;
const sequenceRelay = <A>(operations: readonly (() => Promise<RelayOutcome<A>>)[]): Promise<RelayOutcome<readonly A[]>> =>
  operations.reduce<Promise<RelayOutcome<readonly A[]>>>((previous, operation) => previous.then(async outcome => {
    if (outcome.status === 'unavailable') return outcome;
    const next = await operation();
    return next.status === 'unavailable' ? next : relaySuccess([...outcome.value, next.value]);
  }), Promise.resolve(relaySuccess([])));

export async function createMonitoring(options: Readonly<{ dataDir?: string; workspaceIds?: readonly string[] }> = {}): Promise<Monitoring> {
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

  // Restore native alarms once at process startup, never from dashboard polling.
  await (options.workspaceIds ?? []).flatMap(workspaceId => [
    ...ports.map(value => () => port(workspaceId, value.id).resume()),
    ...demoShipments().map(value => () => shipment(workspaceId, value.id).resume()),
  ]).reduce<Promise<void>>((previous, resume) => previous.then(resume), Promise.resolve()).catch(async error => {
    await runtime.stop();
    throw error;
  });

  const initialize = async (workspaceId: string): Promise<RelayOutcome<readonly Shipment[]>> => {
    const seeds = demoShipments();
    const initialized = await sequenceRelay<null>([
      () => port(workspaceId, 'singapore').initialize(workspaceId, 'singapore', workspaceKey, true),
      ...ports.filter(value => value.id !== 'singapore').map(value => () => port(workspaceId, value.id).initialize(workspaceId, value.id, workspaceKey, false)),
      ...seeds.map(value => () => shipment(workspaceId, value.id).initialize(workspaceId, value, workspaceKey)),
    ]);
    return initialized.status === 'unavailable' ? initialized : relaySuccess(seeds);
  };
  const dashboard = async (workspaceId: string): Promise<RelayOutcome<Dashboard>> => {
    const initialized = await initialize(workspaceId);
    if (initialized.status === 'unavailable') return initialized;
    const snapshots = await Promise.all(initialized.value.map(value => shipment(workspaceId, value.id).snapshot()));
    const retained = snapshots.filter((value): value is Shipment => value !== null);
    if (retained.length !== initialized.value.length) return { status: 'unavailable', message: 'A durable shipment is missing after initialization.' };
    return relaySuccess({
      shipments: retained, ports,
      updatedAt: new Date().toISOString(), mode: 'simulation',
      runtime: 'Terse Durable Actors · retained state', relay: 'Agent Relay · synthetic disruptions only',
    });
  };
  return {
    dashboard,
    simulate: async (workspaceId, portId, delayHours) => {
      const initialized = await initialize(workspaceId);
      if (initialized.status === 'unavailable') return initialized;
      const id = randomUUID();
      const disruption: Disruption = {
        id, portId, delayHours,
        evidence: { id, source: 'simulation', title: 'Simulated port congestion', detail: `Synthetic terminal bulletin: a ${delayHours}-hour berth delay at ${ports.find(value => value.id === portId)?.name ?? portId}. Deterministic demo assessment; not live intelligence.`, observedAt: new Date().toISOString() },
      };
      await port(workspaceId, portId).simulate(disruption);
      const publication = await port(workspaceId, portId).check();
      if (publication.status === 'unavailable') return publication;
      const checked = await sequenceRelay(initialized.value.map(value => () => shipment(workspaceId, value.id).check()));
      return checked.status === 'unavailable' ? checked : dashboard(workspaceId);
    },
    close: () => runtime.stop(),
  };
}
