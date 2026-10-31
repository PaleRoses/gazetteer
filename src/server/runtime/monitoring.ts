import { AgentRelay } from '@agent-relay/sdk';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chmod, mkdir } from 'node:fs/promises';
import { startLocalActors } from 'durable-actors/dev';
import { createActorStub, createActorTransport, type ActorRpcMethod } from 'durable-actors/backend';
import { activePorts, demoShipments } from '../../core/demo';
import { ports, type PortId } from '../../core/ports';
import { relaySuccess, type Comment, type Dashboard, type Disruption, type RelayOutcome, type Shipment } from '../../core/types';
import type { HazardWatch } from '../agents/city/hazard-watch';
import type { TrafficWatch } from '../agents/city/traffic-watch';
import type { ShipAnswer, ShipmentAgent } from '../agents/ship/agent';
import { createBoardModel, recentBoard } from '../relay/model';
import { boardFrom, postBoard } from '../relay/board';
import { transmit, type Transmitted } from '../relay/outbox';
import { cityElements, cityStatuses } from '../../core/city';
import { concerns, type CityElement } from '../../core/board';
import { createCoalescer } from './coalesce';
import { createDelivery } from './delivery';
import type { Inbox } from '../relay/inbox';
import { createLimiter, createStartup, type StartupTask } from './startup';
import { fileSeqStore, startRelayLive } from '../relay/live';
import { createHub, type Subscribe } from './hub';
import { actorClients, createRecovery } from './recovery';
import { attemptRelay, disruptionFrom, publishDisruption, relayChannel, workspaceOfChannel } from '../relay/client';

type TrafficClient = Pick<TrafficWatch, 'initialize' | 'check' | 'resume' | 'deliver' | 'unpublished' | 'acknowledge'>;
type HazardClient = Pick<HazardWatch, 'initialize' | 'simulate' | 'check' | 'resume' | 'queued' | 'unpublished' | 'acknowledge'>;
/** What the runtime asks of every agent stationed at a city, whatever element it watches. */
type WatchClient = Pick<TrafficClient & HazardClient, 'initialize' | 'check' | 'resume' | 'unpublished' | 'acknowledge'>;
type ShipmentClient = Pick<ShipmentAgent, 'initialize' | 'snapshot' | 'ask' | 'check' | 'resume' | 'deliver' | 'unpublished' | 'acknowledge'>;
const trafficMethods = [
  { name: 'initialize', result: 'value' }, { name: 'check', result: 'value' }, { name: 'resume', result: 'void' },
  { name: 'deliver', result: 'void' }, { name: 'unpublished', result: 'value' }, { name: 'acknowledge', result: 'void' },
] satisfies readonly (ActorRpcMethod & { name: keyof TrafficClient })[];
const hazardMethods = [
  { name: 'initialize', result: 'value' }, { name: 'simulate', result: 'void' }, { name: 'check', result: 'value' },
  { name: 'resume', result: 'void' }, { name: 'queued', result: 'value' }, { name: 'unpublished', result: 'value' }, { name: 'acknowledge', result: 'void' },
] satisfies readonly (ActorRpcMethod & { name: keyof HazardClient })[];
const shipmentMethods = [
  { name: 'initialize', result: 'value' }, { name: 'snapshot', result: 'value' }, { name: 'ask', result: 'value' }, { name: 'check', result: 'value' },
  { name: 'resume', result: 'void' }, { name: 'deliver', result: 'void' }, { name: 'unpublished', result: 'value' }, { name: 'acknowledge', result: 'void' },
] satisfies readonly (ActorRpcMethod & { name: keyof ShipmentClient })[];

export type Monitoring = Readonly<{
  dashboard(workspaceId: string): Promise<RelayOutcome<Dashboard>>;
  simulate(workspaceId: string, portId: PortId, delayHours: number): Promise<RelayOutcome<Dashboard>>;
  /** Push channel behind GET /api/workspaces/:id/events. */
  subscribe: Subscribe;
  publishComment(workspaceId: string, shipmentId: string, comment: Comment): void;
  /** Demo controls for act 2: the haulier withdraws its last truck; the cargo agent resumes from its persisted case. Each answers with the dashboard. */
  withdrawTruck(workspaceId: string): Promise<RelayOutcome<Dashboard>>;
  restartCargo(workspaceId: string): Promise<RelayOutcome<Dashboard>>;
  /** The ship's mind answers as itself, read-only; unavailable (never thrown) without the model or past its deadline. */
  ask(workspaceId: string, shipmentId: string, question: string): Promise<ShipAnswer>;
  close(): Promise<void>;
}>;
export async function createMonitoring(options: Readonly<{ dataDir?: string; workspaceIds: readonly string[]; hasWorkspace?: (workspaceId: string) => boolean }>): Promise<Monitoring> {
  const workspaceKey = process.env.RELAY_WORKSPACE_KEY;
  if (!workspaceKey) throw new Error('Agent Relay is not configured. Run npm run setup:relay first.');
  const project = resolve(import.meta.dir, '../../..');
  const dataDir = resolve(project, options.dataDir ?? resolve(process.env.DATA_DIR ?? '.data', 'actors'));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  // The ship minds' SDK transcripts live beside the actor data, never in ~/.claude; the actor host inherits this environment.
  process.env.GAZETTEER_MINDS_DIR = resolve(dataDir, 'minds');
  const runtime = await startLocalActors({
    project, projectId: 'gazetteer', entrypoint: 'src/server/agents/index.ts',
    dataDir, apiKey: randomUUID(), quiet: true,
  });
  const transport = createActorTransport({
    projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl,
    apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion,
  });
  const traffic = (workspaceId: string, id: PortId): TrafficClient => createActorStub<TrafficClient>('TrafficWatch', `${workspaceId}-city-${id}-traffic`, trafficMethods, transport);
  const hazards = (workspaceId: string, id: PortId): HazardClient => createActorStub<HazardClient>('HazardWatch', `${workspaceId}-city-${id}-hazards`, hazardMethods, transport);
  const watch = (workspaceId: string, id: PortId, element: CityElement): WatchClient => element === 'traffic' ? traffic(workspaceId, id) : hazards(workspaceId, id);
  const shipment = (workspaceId: string, id: string): ShipmentClient => createActorStub<ShipmentClient>('ShipmentAgent', `${workspaceId}-shipment-${id}`, shipmentMethods, transport);
  /** Only the ports the fleet still calls at run an actor; the rest are shown, normal and irrelevant, without one. */
  const actorPorts = activePorts(demoShipments());
  /** Each city a shipment calls at has one agent per element; the cities themselves are not actors. */
  const watches = actorPorts.flatMap(city => cityElements.map(element => ({ city: city.id, element })));

  // Restore native alarms once at process startup, never from dashboard polling.
  await options.workspaceIds.flatMap(workspaceId => [
    ...watches.map(value => () => watch(workspaceId, value.city, value.element).resume()),
    ...demoShipments().map(value => () => shipment(workspaceId, value.id).resume()),
  ]).reduce<Promise<void>>((previous, resume) => previous.then(resume), Promise.resolve()).catch(async error => {
    await runtime.stop();
    throw error;
  });

  const hub = createHub();
  const relay = new AgentRelay({ workspaceKey });
  const board = createBoardModel(workspaceId => recentBoard(request => relay.messages.list(relayChannel(workspaceId), request)), { onHydrated: workspaceId => { if (hub.subscribers(workspaceId) > 0) void announce(workspaceId); } });
  /** Relay is rate limited and slow: every Relay-touching actor call from here shares eight slots. */
  const relayLimit = createLimiter(8);

  const cityKey = (id: PortId, element: CityElement): string => `city:${id}:${element}`;
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
  /** Ready means initialised. The actor's one Relay read (its history) follows in the background through the shared slots, so readiness never waits on it. */
  const bringUp = (initialize: () => Promise<RelayOutcome<null>>, sync: () => Promise<RelayOutcome<unknown>>) => async (): Promise<boolean> => {
    if ((await initialize()).status !== 'ok') return false;
    void relayLimit(sync).catch(() => undefined);
    return true;
  };
  /** The first actor port in registry order creates the workspace channel; every other actor starts after it. */
  const tasksOf = (workspaceId: string): readonly StartupTask[] => {
    const creator = watches[0] ? cityKey(watches[0].city, watches[0].element) : undefined;
    const afterCreator = creator ? { after: creator } : {};
    return [
      ...watches.map((value, index): StartupTask => ({ key: cityKey(value.city, value.element), ...(index > 0 ? afterCreator : {}), run: bringUp(() => watch(workspaceId, value.city, value.element).initialize(workspaceId, value.city, workspaceKey, index === 0), () => watch(workspaceId, value.city, value.element).check()) })),
      ...seedsOf(workspaceId).map((seed): StartupTask => ({ key: shipKey(seed.id), ...afterCreator, run: bringUp(() => shipment(workspaceId, seed.id).initialize(workspaceId, seed, workspaceKey), () => shipment(workspaceId, seed.id).check()) })),
    ];
  };
  /**
   * The read model. The dashboard is served from here and never calls an actor: Terse serialises calls per actor, so a read would wait
   * behind that actor's in-flight alarm. Actors feed it in the background (`capture`, `captureQueued`), and the SSE stream carries each
   * change. Ships start as their catalog seed, which IS the actor's initial state, so a cold workspace renders its whole fleet at once.
   */
  const snapshots = new Map<string, Map<string, Shipment>>();
  const shipmentsOf = (workspaceId: string): readonly Shipment[] => seedsOf(workspaceId).map(seed => snapshots.get(workspaceId)?.get(seed.id) ?? seed);
  const capture = createCoalescer(async key => {
    const [workspaceId, id] = key.split('\u0000') as [string, string];
    const latest = await shipment(workspaceId, id).snapshot();
    if (!latest) return;
    snapshots.set(workspaceId, (snapshots.get(workspaceId) ?? new Map<string, Shipment>()).set(id, latest));
    if (hub.subscribers(workspaceId) > 0) void announce(workspaceId);
  }, error => console.error('Snapshot capture failed:', error instanceof Error ? error.message : 'unknown error'));
  /** Simulated disruptions wait in their port actor's persisted state, so a restart cannot lose them; this is the last count heard from the ports. */
  const waiting = new Map<string, Map<PortId, number>>();
  const waitingIn = (workspaceId: string): number => [...(waiting.get(workspaceId)?.values() ?? [])].reduce((total, count) => total + count, 0);
  const captureQueued = createCoalescer(async workspaceId => {
    const counts = await Promise.all(actorPorts.map(async value => [value.id, await hazards(workspaceId, value.id).queued().catch(() => 0)] as const));
    waiting.set(workspaceId, new Map(counts));
    if (hub.subscribers(workspaceId) > 0) void announce(workspaceId);
  }, error => console.error('Queue count failed:', error instanceof Error ? error.message : 'unknown error'));
  /** Relay's health is data on the dashboard, never a status code: failing since T, or live with the last acknowledged post at T. */
  const relayHealth = { failingSince: null as string | null, lastPostAt: null as string | null };
  const noteTransmit = (sent: Transmitted): void => {
    const now = new Date().toISOString();
    if (sent.board.length + sent.disruptions.length > 0) relayHealth.lastPostAt = now;
    relayHealth.failingSince = sent.failure === null ? null : relayHealth.failingSince ?? now;
  };

  /** First touch of a workspace starts its actors and counts what already waits for them, both in the background. */
  const begin = (workspaceId: string): void => {
    if (startup.isStarted(workspaceId)) return;
    startup.ensure(workspaceId);
    recovery.begin(workspaceId);
    void captureQueued(workspaceId);
  };

  const dashboard = async (workspaceId: string): Promise<RelayOutcome<Dashboard>> => {
    begin(workspaceId);
    const status = startup.status(workspaceId);
    const retained = shipmentsOf(workspaceId);
    const posts = board.board(workspaceId);
    const queued = waitingIn(workspaceId);
    const built: Dashboard = {
      shipments: retained, ports, ...(posts ? { board: posts, portStatus: cityStatuses(ports, retained, posts) } : {}),
      updatedAt: new Date().toISOString(), mode: process.env.GAZETTEER_LIVE_SOURCES === 'off' ? 'simulation' : 'mixed',
      runtime: 'Terse Durable Actors · retained state', relay: 'Agent Relay · simulated and live disruptions, each labelled',
      relayHealth: { state: relayHealth.failingSince ? 'reconnecting' : 'live', since: relayHealth.failingSince, lastPostAt: relayHealth.lastPostAt },
      ...(recovery.view(workspaceId) ? { recovery: recovery.view(workspaceId) } : {}),
      ...(status.complete ? {} : { startup: { ready: status.ready, total: status.total, ...(queued > 0 ? { queued } : {}) } }),
    };
    hub.publishDashboard(workspaceId, built);
    return relaySuccess(built);
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
  /** Each ready actor has a server-side watermark: a deliver that fails is re-sent, cumulatively, until the actor has taken it. */
  const delivery = createDelivery();
  const deliverTo = (workspaceId: string, key: string): Promise<void> => {
    const arrived = actorPorts.find(value => cityKey(value.id, 'traffic') === key);
    if (arrived) return delivery.deliver(workspaceId, key, batch => traffic(workspaceId, arrived.id).deliver(batch), batch => batch.board.length > 0);
    const ship = seedsOf(workspaceId).find(seed => shipKey(seed.id) === key);
    return ship ? delivery.deliver(workspaceId, key, batch => shipment(workspaceId, ship.id).deliver(batch)) : Promise.resolve();
  };
  const absorb = async (workspaceId: string, batch: Inbox): Promise<number> => {
    const fresh: Inbox = { board: batch.board.filter(message => firstSight(`b:${message.id}`)), disruptions: batch.disruptions.filter(item => firstSight(`d:${item.id}`)) };
    const count = fresh.board.length + fresh.disruptions.length;
    if (count === 0) return 0;
    board.ingest(workspaceId, fresh.board);
    const wake = touched.get(workspaceId) ?? new Set<PortId>();
    fresh.board.filter(message => message.kind === 'ship.observation' || message.kind === 'ship.eta').forEach(message => concerns(message).ports.forEach(id => wake.add(id)));
    touched.set(workspaceId, wake);
    delivery.record(workspaceId, fresh);
    void recovery.deliver(workspaceId, fresh);
    await Promise.all([
      ...actorPorts.filter(value => startup.isReady(workspaceId, cityKey(value.id, 'traffic'))).map(value => deliverTo(workspaceId, cityKey(value.id, 'traffic'))),
      ...seedsOf(workspaceId).filter(seed => startup.isReady(workspaceId, shipKey(seed.id))).map(seed => deliverTo(workspaceId, shipKey(seed.id))),
    ]);
    return count;
  };
  /**
   * Writing to Relay is background work on the shared slots, done here and not inside the actor: an actor awaiting Relay would hold
   * its own queue (deliver, check) for as long as Relay takes. Whatever fails stays in the actor's durable outbox for the next attempt.
   */
  const publishCity = createCoalescer(async key => {
    const [workspaceId, id, element] = key.split('\u0000') as [string, PortId, CityElement];
    const outgoing = await watch(workspaceId, id, element).unpublished();
    if (!outgoing || outgoing.board.length + outgoing.disruptions.length === 0) return;
    const sent = await relayLimit(() => transmit(outgoing, {
      post: message => postBoard(outgoing.relay, message),
      publish: disruption => attemptRelay(() => publishDisruption(outgoing.relay, disruption), 'Agent Relay publication is unavailable.'),
    }));
    noteTransmit(sent);
    await watch(workspaceId, id, element).acknowledge({ board: sent.board, disruptions: sent.disruptions });
  });
  const publishShip = createCoalescer(async key => {
    const [workspaceId, id] = key.split('\u0000') as [string, string];
    const outgoing = await shipment(workspaceId, id).unpublished();
    if (!outgoing || outgoing.board.length === 0) return;
    const sent = await relayLimit(() => transmit(outgoing, { post: message => postBoard(outgoing.relay, message), publish: () => Promise.resolve(relaySuccess(null)) }));
    noteTransmit(sent);
    await shipment(workspaceId, id).acknowledge(sent.board);
  });
  const shipStep = async (workspaceId: string, id: string): Promise<number> => {
    await shipment(workspaceId, id).check().catch(() => undefined);
    const outgoing = await shipment(workspaceId, id).unpublished().catch(() => null);
    const echoed = await absorb(workspaceId, { board: outgoing?.board ?? [], disruptions: [] });
    void publishShip(`${workspaceId}\u0000${id}`);
    void capture(`${workspaceId}\u0000${id}`);
    return echoed;
  };
  const cityStep = async (workspaceId: string, id: PortId, element: CityElement): Promise<number> => {
    await watch(workspaceId, id, element).check().catch(() => undefined);
    const outgoing = await watch(workspaceId, id, element).unpublished().catch(() => null);
    const echoed = await absorb(workspaceId, { board: outgoing?.board ?? [], disruptions: outgoing?.disruptions ?? [] });
    void publishCity(`${workspaceId}\u0000${id}\u0000${element}`);
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
      recovery.step(workspaceId),
      ...wake.filter(id => startup.isReady(workspaceId, cityKey(id, 'traffic'))).map(id => cityStep(workspaceId, id, 'traffic')),
      ...seedsOf(workspaceId).filter(seed => startup.isReady(workspaceId, shipKey(seed.id))).map(seed => shipStep(workspaceId, seed.id).then(count => { if (hub.subscribers(workspaceId) > 0) void announce(workspaceId); return count; })),
    ]);
    if (spoken.some(count => count > 0) && round + 1 < rounds) return settle(workspaceId, round + 1);
  };
  const recovery = createRecovery({
    clients: actorClients(transport), workspaceKey, bookingsPath: resolve(dataDir, '..', 'bookings.sqlite'), limit: relayLimit,
    meridianStar: workspaceId => shipment(workspaceId, 'gz-1042').snapshot(),
    send: async outgoing => {
      const sent = await relayLimit(() => transmit(outgoing, { post: message => postBoard(outgoing.relay, message), publish: () => Promise.resolve(relaySuccess(null)) }));
      noteTransmit(sent);
      return sent;
    },
    absorb, announce: workspaceId => { if (hub.subscribers(workspaceId) > 0) void announce(workspaceId); },
  });
  const refresh = createCoalescer(async workspaceId => {
    begin(workspaceId);
    await settle(workspaceId);
    await dashboard(workspaceId);
  }, error => console.error('Realtime refresh failed:', error instanceof Error ? error.message : 'unknown error'));
  /** A port actor that just became ready has adopted what waited for it: say so now instead of at the next alarm. */
  const deliverQueued = async (workspaceId: string, id: PortId): Promise<void> => {
    if (await hazards(workspaceId, id).queued() === 0) return;
    await cityStep(workspaceId, id, 'hazards');
    await refresh(workspaceId);
  };
  const startup = createStartup({
    tasksOf, limit: relayLimit,
    onReady: (workspaceId, key) => {
      void deliverTo(workspaceId, key);
      const arrived = actorPorts.find(value => cityKey(value.id, 'hazards') === key);
      const ship = seedsOf(workspaceId).find(seed => shipKey(seed.id) === key);
      if (ship) void capture(`${workspaceId}\u0000${ship.id}`);
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
    ask: (workspaceId, shipmentId, question) => shipment(workspaceId, shipmentId).ask(question)
      .catch((error: unknown): ShipAnswer => ({ status: 'unavailable', message: `The ship mind is unavailable: ${error instanceof Error ? error.message : String(error)}` })),
    simulate: async (workspaceId, portId, delayHours) => {
      begin(workspaceId);
      const id = randomUUID();
      const disruption: Disruption = {
        id, portId, delayHours,
        evidence: { id, source: 'simulation', title: 'Simulated port congestion', detail: `Synthetic terminal bulletin: a ${delayHours}-hour berth delay at ${ports.find(value => value.id === portId)?.name ?? portId}. Deterministic demo assessment; not live intelligence.`, observedAt: new Date().toISOString() },
      };
      /** Accepted into the port's durable queue is the answer; echoing, publishing and the actors' reactions follow in the background. */
      const accepted = hazards(workspaceId, portId).simulate(disruption)
        .then(async () => {
          void captureQueued(workspaceId);
          if (!startup.isReady(workspaceId, cityKey(portId, 'hazards'))) return;
          await absorb(workspaceId, { board: [], disruptions: [disruption] });
          void publishCity(`${workspaceId}\u0000${portId}\u0000hazards`);
          await refresh(workspaceId);
        })
        .catch(error => console.error('Simulated disruption failed:', error instanceof Error ? error.message : 'unknown error'));
      await Promise.race([accepted, new Promise(done => setTimeout(done, simulateWaitMs))]);
      return dashboard(workspaceId);
    },
    withdrawTruck: async workspaceId => {
      begin(workspaceId);
      const done = await recovery.withdrawTruck(workspaceId);
      if (done.status !== 'ok') return done;
      await refresh(workspaceId);
      return dashboard(workspaceId);
    },
    restartCargo: async workspaceId => {
      begin(workspaceId);
      const done = await recovery.restartCargo(workspaceId);
      if (done.status !== 'ok') return done;
      await refresh(workspaceId);
      return dashboard(workspaceId);
    },
    subscribe: hub.subscribe,
    publishComment: (workspaceId, shipmentId, comment) => hub.publish(workspaceId, { event: 'comment', data: { shipmentId, comment } }),
    close: async () => {
      startup.close();
      recovery.close();
      delivery.close();
      if (live.status === 'ok') await live.value.close();
      await runtime.stop();
    },
  };
}
