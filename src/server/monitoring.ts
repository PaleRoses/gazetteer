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
import { boardFrom, postBoard } from './board/transport';
import { transmit } from './realtime/outbox';
import { portStatuses } from './port/status';
import { concerns } from '../board';
import { createCoalescer } from './realtime/coalesce';
import type { Inbox } from './realtime/inbox';
import { createLimiter, createStartup, type StartupTask } from './realtime/startup';
import { fileSeqStore, startRelayLive } from './realtime/live';
import { createHub, type Subscribe } from './realtime/sse';
import { attemptRelay, disruptionFrom, publishDisruption, relayChannel, workspaceOfChannel } from './relay';

type PortClient = Pick<PortAgent, 'initialize' | 'simulate' | 'check' | 'resume' | 'deliver' | 'queued' | 'unpublished' | 'acknowledge'>;
type ShipmentClient = Pick<ShipmentAgent, 'initialize' | 'snapshot' | 'check' | 'resume' | 'deliver' | 'unpublished' | 'acknowledge'>;
const portMethods = [
  { name: 'initialize', result: 'value' }, { name: 'simulate', result: 'void' }, { name: 'check', result: 'value' },
  { name: 'resume', result: 'void' }, { name: 'deliver', result: 'void' }, { name: 'queued', result: 'value' },
  { name: 'unpublished', result: 'value' }, { name: 'acknowledge', result: 'void' },
] satisfies readonly (ActorRpcMethod & { name: keyof PortClient })[];
const shipmentMethods = [
  { name: 'initialize', result: 'value' }, { name: 'snapshot', result: 'value' }, { name: 'check', result: 'value' },
  { name: 'resume', result: 'void' }, { name: 'deliver', result: 'void' }, { name: 'unpublished', result: 'value' }, { name: 'acknowledge', result: 'void' },
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
  /** Ready means initialised AND synced: the actor's one Relay read (its history) is paid here, in the background, so no later check waits on Relay. */
  const bringUp = (initialize: () => Promise<RelayOutcome<null>>, sync: () => Promise<RelayOutcome<unknown>>) => async (): Promise<boolean> =>
    (await initialize()).status === 'ok' && (await sync()).status === 'ok';
  const tasksOf = (workspaceId: string): readonly StartupTask[] => [
    { key: portKey('singapore'), run: bringUp(() => port(workspaceId, 'singapore').initialize(workspaceId, 'singapore', workspaceKey, true), () => port(workspaceId, 'singapore').check()) },
    ...ports.filter(value => value.id !== 'singapore').map((value): StartupTask => ({ key: portKey(value.id), after: portKey('singapore'), run: bringUp(() => port(workspaceId, value.id).initialize(workspaceId, value.id, workspaceKey, false), () => port(workspaceId, value.id).check()) })),
    ...seedsOf(workspaceId).map((seed): StartupTask => ({ key: shipKey(seed.id), after: portKey('singapore'), run: bringUp(() => shipment(workspaceId, seed.id).initialize(workspaceId, seed, workspaceKey), () => shipment(workspaceId, seed.id).check()) })),
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

  const announce = createCoalescer(async workspaceId => { await dashboard(workspaceId); }, error => console.error('Board announcement failed:', error instanceof Error ? error.message : 'unknown error'));

  /**
   * Relay stays the bus and the record, but nothing here waits on its latency. A message is absorbed once, whether it was authored
   * locally (echo) or heard on the stream (the Relay copy of an echo is then a no-op): into the read model and into every ready actor's
   * inbox by local RPC. Ports are told which of them a ship's post concerns.
   */
  const absorbed = new Set<string>();
  const firstSight = (key: string): boolean => {
    if (absorbed.has(key)) return false;
    absorbed.add(key);
    if (absorbed.size > 5000) absorbed.delete(absorbed.values().next().value as string);
    return true;
  };
  const touched = new Map<string, Set<PortId>>();
  const absorb = async (workspaceId: string, batch: Inbox): Promise<number> => {
    const fresh: Inbox = { board: batch.board.filter(message => firstSight(`b:${message.id}`)), disruptions: batch.disruptions.filter(item => firstSight(`d:${item.id}`)) };
    const count = fresh.board.length + fresh.disruptions.length;
    if (count === 0) return 0;
    board.ingest(workspaceId, fresh.board);
    const wake = touched.get(workspaceId) ?? new Set<PortId>();
    fresh.board.filter(message => message.kind === 'ship.observation' || message.kind === 'ship.eta').forEach(message => concerns(message).ports.forEach(id => wake.add(id)));
    touched.set(workspaceId, wake);
    await Promise.all([
      ...ports.filter(value => startup.isReady(workspaceId, portKey(value.id)) && fresh.board.length > 0).map(value => port(workspaceId, value.id).deliver(fresh).catch(() => undefined)),
      ...seedsOf(workspaceId).filter(seed => startup.isReady(workspaceId, shipKey(seed.id))).map(seed => shipment(workspaceId, seed.id).deliver(fresh).catch(() => undefined)),
    ]);
    return count;
  };
  /**
   * Writing to Relay is background work on the shared slots, done here and not inside the actor: an actor awaiting Relay would hold
   * its own queue (deliver, check) for as long as Relay takes. Whatever fails stays in the actor's durable outbox for the next attempt.
   */
  const publishPort = createCoalescer(async key => {
    const [workspaceId, id] = key.split('\u0000') as [string, PortId];
    const outgoing = await port(workspaceId, id).unpublished();
    if (!outgoing || outgoing.board.length + outgoing.disruptions.length === 0) return;
    const sent = await relayLimit(() => transmit(outgoing, {
      post: message => postBoard(outgoing.relay, message),
      publish: disruption => attemptRelay(() => publishDisruption(outgoing.relay, disruption), 'Agent Relay publication is unavailable.'),
    }));
    await port(workspaceId, id).acknowledge({ board: sent.board, disruptions: sent.disruptions });
  });
  const publishShip = createCoalescer(async key => {
    const [workspaceId, id] = key.split('\u0000') as [string, string];
    const outgoing = await shipment(workspaceId, id).unpublished();
    if (!outgoing || outgoing.board.length === 0) return;
    const sent = await relayLimit(() => transmit(outgoing, { post: message => postBoard(outgoing.relay, message), publish: () => Promise.resolve(relaySuccess(null)) }));
    await shipment(workspaceId, id).acknowledge(sent.board);
  });
  const shipStep = async (workspaceId: string, id: string): Promise<number> => {
    await shipment(workspaceId, id).check().catch(() => undefined);
    const outgoing = await shipment(workspaceId, id).unpublished().catch(() => null);
    const echoed = await absorb(workspaceId, { board: outgoing?.board ?? [], disruptions: [] });
    void publishShip(`${workspaceId}\u0000${id}`);
    return echoed;
  };
  const portStep = async (workspaceId: string, id: PortId): Promise<number> => {
    await port(workspaceId, id).check().catch(() => undefined);
    const outgoing = await port(workspaceId, id).unpublished().catch(() => null);
    const echoed = await absorb(workspaceId, { board: outgoing?.board ?? [], disruptions: outgoing?.disruptions ?? [] });
    void publishPort(`${workspaceId}\u0000${id}`);
    return echoed;
  };
  /** The HTTP answer never waits longer than this for assessments; the SSE stream carries whatever finishes later. */
  const simulateWaitMs = 2000;
  const rounds = 4;
  /** Ships and the ports they concerned react to each other until nothing new is said (bounded; the alarms resume it otherwise). */
  const settle = async (workspaceId: string, round = 0): Promise<void> => {
    const wake = [...(touched.get(workspaceId) ?? [])];
    touched.delete(workspaceId);
    const spoken = await Promise.all([
      ...wake.filter(id => startup.isReady(workspaceId, portKey(id))).map(id => portStep(workspaceId, id)),
      ...seedsOf(workspaceId).filter(seed => startup.isReady(workspaceId, shipKey(seed.id))).map(seed => shipStep(workspaceId, seed.id).then(count => { if (hub.subscribers(workspaceId) > 0) void announce(workspaceId); return count; })),
    ]);
    if (spoken.some(count => count > 0) && round + 1 < rounds) return settle(workspaceId, round + 1);
  };
  const refresh = createCoalescer(async workspaceId => {
    startup.ensure(workspaceId);
    await settle(workspaceId);
    await dashboard(workspaceId);
  }, error => console.error('Realtime refresh failed:', error instanceof Error ? error.message : 'unknown error'));
  /** A port actor that just became ready has adopted what waited for it: say so now instead of at the next alarm. */
  const deliverQueued = async (workspaceId: string, id: PortId): Promise<void> => {
    if (await port(workspaceId, id).queued() === 0) return;
    await portStep(workspaceId, id);
    await refresh(workspaceId);
  };
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
      void absorb(workspaceId, { board: post ? [post] : [], disruptions: disruption ? [disruption] : [] })
        .then(count => (count > 0 ? refresh(workspaceId) : undefined));
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
      await absorb(workspaceId, { board: [], disruptions: [disruption] });
      void publishPort(`${workspaceId}\u0000${portId}`);
      await Promise.race([refresh(workspaceId), new Promise(done => setTimeout(done, simulateWaitMs))]);
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
