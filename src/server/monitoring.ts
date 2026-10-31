import { AgentRelay } from '@agent-relay/sdk';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { startLocalActors } from 'durable-actors/dev';
import { createActorStub, createActorTransport, type ActorRpcMethod } from 'durable-actors/backend';
import { demoShipments, ports } from '../domain';
import { relaySuccess, type Comment, type Dashboard, type Disruption, type PortId, type RelayOutcome, type Shipment } from '../shared';
import type { PortAgent, ShipmentAgent } from './actors';
import { createBoardModel, recentBoard } from './board/model';
import { boardFrom } from './board/transport';
import { portStatuses } from './port/status';
import { concerns } from '../board';
import { createCoalescer } from './realtime/coalesce';
import type { Inbox } from './realtime/inbox';
import { createLimiter, createStartup, type StartupTask } from './realtime/startup';
import { fileSeqStore, startRelayLive } from './realtime/live';
import { createHub, type Subscribe } from './realtime/sse';
import { disruptionFrom, relayChannel, workspaceOfChannel } from './relay';

type PortClient = Pick<PortAgent, 'initialize' | 'simulate' | 'check' | 'resume' | 'deliver' | 'queued'>;
type ShipmentClient = Pick<ShipmentAgent, 'initialize' | 'snapshot' | 'check' | 'resume' | 'deliver'>;
const portMethods = [
  { name: 'initialize', result: 'value' }, { name: 'simulate', result: 'void' }, { name: 'check', result: 'value' },
  { name: 'resume', result: 'void' }, { name: 'deliver', result: 'void' }, { name: 'queued', result: 'value' },
] satisfies readonly (ActorRpcMethod & { name: keyof PortClient })[];
const shipmentMethods = [
  { name: 'initialize', result: 'value' }, { name: 'snapshot', result: 'value' }, { name: 'check', result: 'value' },
  { name: 'resume', result: 'void' }, { name: 'deliver', result: 'void' },
] satisfies readonly (ActorRpcMethod & { name: keyof ShipmentClient })[];

export type Monitoring = Readonly<{
  dashboard(workspaceId: string): Promise<RelayOutcome<Dashboard>>;
  simulate(workspaceId: string, portId: PortId, delayHours: number): Promise<RelayOutcome<Dashboard>>;
  /** Push channel behind GET /api/workspaces/:id/events. */
  subscribe: Subscribe;
  publishComment(workspaceId: string, shipmentId: string, comment: Comment): void;
  close(): Promise<void>;
}>;
export async function createMonitoring(options: Readonly<{ dataDir?: string; workspaceIds: readonly string[]; hasWorkspace?: (workspaceId: string) => boolean }>): Promise<Monitoring> {
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
  await options.workspaceIds.flatMap(workspaceId => [
    ...ports.map(value => () => port(workspaceId, value.id).resume()),
    ...demoShipments().map(value => () => shipment(workspaceId, value.id).resume()),
  ]).reduce<Promise<void>>((previous, resume) => previous.then(resume), Promise.resolve()).catch(async error => {
    await runtime.stop();
    throw error;
  });

  const hub = createHub();
  const relay = new AgentRelay({ workspaceKey });
  const board = createBoardModel(workspaceId => recentBoard(request => relay.messages.list(relayChannel(workspaceId), request)), { onHydrated: workspaceId => { if (hub.subscribers(workspaceId) > 0) void announce(workspaceId); } });
  /** Relay is rate limited and slow: every Relay-touching actor call from here shares three slots. */
  const relayLimit = createLimiter(3);

  const portKey = (id: PortId): string => `port:${id}`;
  const shipKey = (id: string): string => `ship:${id}`;
  /** The seeds ARE each shipment actor's initial state, so the dashboard may show them honestly before the actor is ready. */
  const seedsByWorkspace = new Map<string, readonly Shipment[]>();
  const seedsOf = (workspaceId: string): readonly Shipment[] => {
    const known = seedsByWorkspace.get(workspaceId);
    if (known) return known;
    const seeds = demoShipments();
    seedsByWorkspace.set(workspaceId, seeds);
    return seeds;
  };
  const tasksOf = (workspaceId: string): readonly StartupTask[] => [
    { key: portKey('singapore'), run: async () => (await port(workspaceId, 'singapore').initialize(workspaceId, 'singapore', workspaceKey, true)).status === 'ok' },
    ...ports.filter(value => value.id !== 'singapore').map((value): StartupTask => ({ key: portKey(value.id), after: portKey('singapore'), run: async () => (await port(workspaceId, value.id).initialize(workspaceId, value.id, workspaceKey, false)).status === 'ok' })),
    ...seedsOf(workspaceId).map((seed): StartupTask => ({ key: shipKey(seed.id), after: portKey('singapore'), run: async () => (await shipment(workspaceId, seed.id).initialize(workspaceId, seed, workspaceKey)).status === 'ok' })),
  ];
  /** Simulated disruptions wait in their port actor's persisted state, not here: a restart cannot lose them. */
  const waitingOn = async (workspaceId: string): Promise<number> =>
    (await Promise.all(ports.map(value => port(workspaceId, value.id).queued().catch(() => 0)))).reduce((total, count) => total + count, 0);

  const dashboard = async (workspaceId: string): Promise<RelayOutcome<Dashboard>> => {
    startup.ensure(workspaceId);
    const status = startup.status(workspaceId);
    try {
      const retained = await Promise.all(seedsOf(workspaceId).map(async seed =>
        (startup.isReady(workspaceId, shipKey(seed.id)) ? await shipment(workspaceId, seed.id).snapshot().catch(() => null) : null) ?? seed));
      const posts = board.board(workspaceId);
      const waiting = status.complete ? 0 : await waitingOn(workspaceId);
      const built: Dashboard = {
        shipments: retained, ports, ...(posts ? { board: posts, portStatus: portStatuses(ports, retained, posts) } : {}),
        updatedAt: new Date().toISOString(), mode: process.env.GAZETTEER_LIVE_SOURCES === 'off' ? 'simulation' : 'mixed',
        runtime: 'Terse Durable Actors · retained state', relay: 'Agent Relay · simulated and live disruptions, each labelled',
        ...(status.complete ? {} : { startup: { ready: status.ready, total: status.total, ...(waiting > 0 ? { queued: waiting } : {}) } }),
      };
      hub.publishDashboard(workspaceId, built);
      return relaySuccess(built);
    } catch {
      return { status: 'unavailable', message: 'The workspace could not be read. Retry shortly.' };
    }
  };

  // A Relay notice is a doorbell: each ready shipment actor re-reads only past its persisted cursor, then the browser is pushed the result.
  const checkReadyShipments = (workspaceId: string): Promise<unknown> => Promise.all(seedsOf(workspaceId)
    .filter(seed => startup.isReady(workspaceId, shipKey(seed.id)))
    .map(seed => relayLimit(() => shipment(workspaceId, seed.id).check()).catch(() => undefined)));
  const refresh = createCoalescer(async workspaceId => {
    startup.ensure(workspaceId);
    await checkReadyShipments(workspaceId);
    await dashboard(workspaceId);
  }, error => console.error('Realtime refresh failed:', error instanceof Error ? error.message : 'unknown error'));
  const announce = createCoalescer(async workspaceId => { await dashboard(workspaceId); }, error => console.error('Board announcement failed:', error instanceof Error ? error.message : 'unknown error'));
  /** A port actor that just became ready has adopted what waited for it: publish it now instead of at the next alarm. */
  const deliverQueued = async (workspaceId: string, id: PortId): Promise<void> => {
    if (await port(workspaceId, id).queued() === 0) return;
    await relayLimit(() => port(workspaceId, id).check());
  };
  /** One Relay stream per process feeds every actor by local RPC: actors read Relay only at start, never per alarm. */
  const fanOut = (workspaceId: string, batch: Inbox): Promise<unknown> => Promise.all([
    ...ports.filter(value => startup.isReady(workspaceId, portKey(value.id)) && batch.board.length > 0).map(value => port(workspaceId, value.id).deliver(batch).catch(() => undefined)),
    ...seedsOf(workspaceId).filter(seed => startup.isReady(workspaceId, shipKey(seed.id))).map(seed => shipment(workspaceId, seed.id).deliver(batch).catch(() => undefined)),
  ]);
  const checkPorts = (workspaceId: string, ids: readonly PortId[]): Promise<unknown> => Promise.all(ids
    .filter(id => startup.isReady(workspaceId, portKey(id)))
    .map(id => relayLimit(() => port(workspaceId, id).check()).catch(() => undefined)));
  const startup = createStartup({
    tasksOf, limit: relayLimit,
    onReady: (workspaceId, key) => {
      const arrived = ports.find(value => portKey(value.id) === key);
      void (arrived ? deliverQueued(workspaceId, arrived.id) : Promise.resolve())
        .catch(error => console.error('Queued disruption delivery failed:', error instanceof Error ? error.message : 'unknown error'))
        .then(() => (hub.subscribers(workspaceId) > 0 ? announce(workspaceId) : undefined));
    },
  });
  const hasWorkspace = options.hasWorkspace ?? (workspaceId => options.workspaceIds.includes(workspaceId));
  const seq = fileSeqStore(resolve(dataDir, '..', 'relay-seq'));
  const live = await startRelayLive({
    workspaceKey, sinceSeq: await seq.load(), onCursor: value => { void seq.save(value); },
    onError: error => console.error('Relay live stream:', error instanceof Error ? error.message : 'unknown error'),
    onMessage: ({ channel, message }) => {
      const workspaceId = workspaceOfChannel(channel);
      if (!workspaceId || !hasWorkspace(workspaceId)) return;
      const post = boardFrom(message);
      const disruption = disruptionFrom(message);
      if (!post && !disruption) return;
      const changed = post ? board.ingest(workspaceId, [post]) : false;
      void fanOut(workspaceId, { board: post ? [post] : [], disruptions: disruption ? [disruption] : [] }).then(() => {
        if (post && post.kind !== 'port.bulletin') void checkPorts(workspaceId, concerns(post).ports);
        return changed || disruption ? refresh(workspaceId) : undefined;
      });
    },
  });
  if (live.status === 'unavailable') console.warn(live.message);
  return {
    dashboard,
    simulate: async (workspaceId, portId, delayHours) => {
      startup.ensure(workspaceId);
      const id = randomUUID();
      const disruption: Disruption = {
        id, portId, delayHours,
        evidence: { id, source: 'simulation', title: 'Simulated port congestion', detail: `Synthetic terminal bulletin: a ${delayHours}-hour berth delay at ${ports.find(value => value.id === portId)?.name ?? portId}. Deterministic demo assessment; not live intelligence.`, observedAt: new Date().toISOString() },
      };
      await port(workspaceId, portId).simulate(disruption);
      if (!startup.isReady(workspaceId, portKey(portId))) return dashboard(workspaceId);
      const publication = await relayLimit(() => port(workspaceId, portId).check());
      if (publication.status === 'unavailable') return publication;
      await checkReadyShipments(workspaceId);
      return dashboard(workspaceId);
    },
    subscribe: hub.subscribe,
    publishComment: (workspaceId, shipmentId, comment) => hub.publish(workspaceId, { event: 'comment', data: { shipmentId, comment } }),
    close: async () => {
      startup.close();
      if (live.status === 'ok') await live.value.close();
      await runtime.stop();
    },
  };
}
