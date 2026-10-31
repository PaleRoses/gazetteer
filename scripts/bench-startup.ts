/**
 * Why does a workspace take so long to become ready? Drives N synthetic actors through the server's own startup (createStartup under
 * createLimiter, the creator first, everyone else after it) against a fake Relay with a configurable per-request latency, or the real one.
 *
 *   bun scripts/bench-startup.ts --actors 5,25,100 --relay fake --latency-ms 0,2000 --concurrency 3,16 --mode before
 *   bun scripts/bench-startup.ts --actors 25 --relay real                      # at most two real runs; N is 5 or 25
 *
 * `before` drives the actors as monitoring.ts does: initialize (register + join inside the actor), then check() (the history read) in the
 * background on the same slots. `after` drives the split API: initialize(workspaceId, seed|city) with no Relay call, then the server
 * registers, joins, adopt(identity)s and syncs in the background; it reports "after mode: API not present" until the actors have adopt().
 * Set BENCH_TMPDIR to choose where the throwaway project and data directories go, BENCH_LOGS=1 to see the actor host's own log. Nothing here writes into the repository.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createActorStub, createActorTransport, type ActorRpcMethod } from 'durable-actors/backend';
import { startLocalActors } from 'durable-actors/dev';
import { demoShipments } from '../src/core/demo';
import { portIds, type PortId } from '../src/core/ports';
import type { RelayOutcome, Shipment } from '../src/core/types';
import type { HazardWatch } from '../src/server/agents/city/hazard-watch';
import type { TrafficWatch } from '../src/server/agents/city/traffic-watch';
import type { ShipmentAgent } from '../src/server/agents/ship/agent';
import { joinChannel, registerParticipant, relayChannel, type RelayIdentity } from '../src/server/relay/client';
import { readChannel } from '../src/server/relay/board';
import { createLimiter, createStartup, type StartupTask } from '../src/server/runtime/startup';

// ---------------------------------------------------------------- arguments

type Relay = 'fake' | 'real';
type Mode = 'before' | 'after';
type Options = Readonly<{ actors: readonly number[]; relay: Relay; latencies: readonly number[]; concurrencies: readonly number[]; mode: Mode; history: number; timeoutMs: number }>;
type Run = Readonly<{ relay: Relay; mode: Mode; actors: number; concurrency: number; latencyMs: number; history: number; timeoutMs: number }>;

const numbers = (text: string): readonly number[] => text.split(',').map(Number).filter(Number.isFinite);
const parseOptions = (argv: readonly string[]): Options => {
  const flag = (name: string, fallback: string): string => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] ?? fallback : fallback; };
  const relay = flag('relay', 'fake');
  const mode = flag('mode', 'before');
  if (relay !== 'fake' && relay !== 'real') throw new Error('--relay is fake or real');
  if (mode !== 'before' && mode !== 'after') throw new Error('--mode is before or after');
  return {
    actors: numbers(flag('actors', '5,25')), relay, latencies: numbers(flag('latency-ms', '0')), concurrencies: numbers(flag('concurrency', '3')), mode,
    history: Number(flag('history', '0')), timeoutMs: Number(flag('timeout-s', '900')) * 1000,
  };
};
const plan = (options: Options): readonly Run[] => options.actors.flatMap(actors => options.concurrencies.flatMap(concurrency =>
  (options.relay === 'real' ? [0] : options.latencies).map(latencyMs => ({ relay: options.relay, mode: options.mode, actors, concurrency, latencyMs, history: options.history, timeoutMs: options.timeoutMs }))));

// ---------------------------------------------------------------- small statistics

const quantile = (values: readonly number[], q: number): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0 ? Number.NaN : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? Number.NaN;
};
const ms = (value: number): string => (Number.isNaN(value) ? '-' : value >= 10_000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`);
const spread = (values: readonly number[]): string => (values.length === 0 ? '-' : `${ms(quantile(values, 0.5))} / ${ms(quantile(values, 0.95))} / ${ms(Math.max(...values))}`);
const pad = (cells: readonly string[], widths: readonly number[]): string => cells.map((cell, at) => cell.padEnd(widths[at] ?? 0)).join('  ').trimEnd();
const table = (rows: readonly (readonly string[])[]): string => {
  const widths = (rows[0] ?? []).map((_, at) => Math.max(...rows.map(row => (row[at] ?? '').length)));
  return rows.map(row => pad(row, widths)).join('\n');
};
const now = (): number => performance.now();
const timed = async <A>(operation: () => Promise<A>): Promise<Readonly<{ value: A; ms: number }>> => { const at = now(); const value = await operation(); return { value, ms: now() - at }; };

const deferred = <A = void>(): Readonly<{ promise: Promise<A>; resolve: (value: A) => void; reject: (error: unknown) => void }> => {
  const hold: { resolve?: (value: A) => void; reject?: (error: unknown) => void } = {};
  const promise = new Promise<A>((resolve, reject) => { hold.resolve = resolve; hold.reject = reject; });
  return { promise, resolve: value => hold.resolve?.(value), reject: error => hold.reject?.(error) };
};

// ---------------------------------------------------------------- the fake Relay

type Hit = Readonly<{ route: string; actor: string; startedAt: number; endedAt: number }>;
const routeOf = (method: string, path: string): string => {
  if (method === 'POST' && path === '/v1/agents') return 'register';
  if (path === '/v1/channels') return method === 'GET' ? 'channels.list' : 'channels.create';
  if (/^\/v1\/channels\/[^/]+\/join$/.test(path)) return 'channels.join';
  if (/^\/v1\/channels\/[^/]+\/messages$/.test(path)) return method === 'GET' ? 'messages.list' : 'messages.post';
  return 'other';
};
const actorOf = (name: string): string => /bench-(?:probe-)?\d+/.exec(name)?.[0] ?? 'other';

const bindInRange = <A>(taken: ReadonlySet<number>, bind: (port: number) => A): Readonly<{ value: A; port: number }> => {
  const attempt = (port: number): Readonly<{ value: A; port: number }> => {
    if (port > 4419) throw new Error('no free port in 4411-4419');
    if (taken.has(port)) return attempt(port + 1);
    try { return { value: bind(port), port }; } catch { return attempt(port + 1); }
  };
  return attempt(4411);
};

/** Enough of the Relay wire protocol to register, join, publish and list; every response waits `latencyMs`, and every request is logged with the actor it belongs to. */
function fakeRelay(latencyMs: number, history: number, taken: ReadonlySet<number>) {
  const hits: Hit[] = [];
  const owners = new Map<string, string>();
  const reply = (data: unknown): Response => Response.json({ ok: true, data });
  const messages = Array.from({ length: history }, (_, at) => ({ id: String(1_000_000 + at), text: `history ${at}`, created_at: new Date(1_700_000_000_000 + at * 1000).toISOString(), metadata: null }));
  const { value: server, port } = bindInRange(taken, bindPort => Bun.serve({
    port: bindPort,
    fetch: async request => {
      const startedAt = now();
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
      const token = /^Bearer (.+)$/.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
      const route = routeOf(request.method, url.pathname);
      const actor = route === 'register' ? actorOf(String(body.name ?? '')) : owners.get(token) ?? 'other';
      const response = ((): Response => {
        if (route === 'register') {
          const issued = `tok-${randomUUID()}`;
          owners.set(issued, actor);
          return reply({ id: randomUUID(), name: body.name, token: issued, type: 'agent', status: 'online', created_at: new Date().toISOString() });
        }
        if (route === 'channels.list') return reply([]);
        if (route === 'channels.create') return reply({ name: body.name, topic: body.topic ?? null, created_at: new Date().toISOString() });
        if (route === 'channels.join') return reply({ ok: true });
        if (route === 'messages.list') return reply(messages);
        if (route === 'messages.post') return reply({ id: `m-${randomUUID()}`, text: body.text, created_at: new Date().toISOString() });
        return Response.json({ ok: false, error: { code: 'not_found', message: 'unhandled' } }, { status: 404 });
      })();
      if (latencyMs > 0) await Bun.sleep(latencyMs);
      hits.push({ route, actor, startedAt, endedAt: now() });
      return response;
    },
  }));
  return { url: `http://127.0.0.1:${port}`, port, hits, stop: () => server.stop(true) };
}

// ---------------------------------------------------------------- the throwaway project

/** Actors read their environment from the project's .env: a project that links the real sources, with live feeds off and Relay pointed where asked. */
function throwawayProject(root: string, env: Readonly<Record<string, string>>): string {
  const real = resolve(import.meta.dir, '..');
  const project = mkdtempSync(join(root, 'project-'));
  ['src', 'node_modules', 'package.json', 'tsconfig.json'].forEach(name => symlinkSync(join(real, name), join(project, name)));
  writeFileSync(join(project, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  return project;
}
const workspaceKeyOf = (): string => {
  const text = readFileSync(resolve(import.meta.dir, '..', '.env'), 'utf8');
  const key = process.env.RELAY_WORKSPACE_KEY ?? /^RELAY_WORKSPACE_KEY=(.+)$/m.exec(text)?.[1]?.trim();
  if (!key) throw new Error('RELAY_WORKSPACE_KEY is not configured');
  return key;
};

// ---------------------------------------------------------------- the actors

type WatchClient = Pick<TrafficWatch, 'initialize' | 'check' | 'resume'> & Pick<HazardWatch, 'initialize' | 'check' | 'resume'>;
type ShipmentClient = Pick<ShipmentAgent, 'initialize' | 'check' | 'resume'>;
/** The split API the server is gaining: initialize without Relay, then adopt an identity registered and joined by the server. */
type SplitWatch = Readonly<{ initialize(workspaceId: string, portId: PortId): Promise<RelayOutcome<null>>; join(workspaceId: string, workspaceKey: string, createChannel: boolean): Promise<RelayOutcome<null>>; check(): Promise<RelayOutcome<unknown>>; resume(): Promise<void> }>;
type SplitShip = Readonly<{ initialize(workspaceId: string, seed: Shipment): Promise<RelayOutcome<null>>; join(workspaceId: string, workspaceKey: string, createChannel: boolean): Promise<RelayOutcome<null>>; check(): Promise<RelayOutcome<unknown>>; resume(): Promise<void> }>;
const methods = ['initialize', 'check', 'resume', 'join'].map((name): ActorRpcMethod => ({ name, result: name === 'resume' ? 'void' : 'value' }));

type Spec = Readonly<{ index: number; kind: 'watch' | 'ship'; element: 'traffic' | 'hazards'; key: string; name: string; portId: PortId; seed: Shipment }>;
/** Roughly one city watch to three ships, the watches alternating between the traffic and hazard element; actor 0 is Singapore's traffic watch, which creates the channel. */
const specsOf = (workspaceId: string, count: number): readonly Spec[] => {
  const fleet = demoShipments();
  return Array.from({ length: count }, (_, index): Spec => {
    const kind = index % 4 === 0 ? 'watch' : 'ship';
    const element = index % 8 === 0 ? 'traffic' : 'hazards';
    const seed = fleet[index % fleet.length];
    if (!seed) throw new Error('empty demo fleet');
    return { index, kind, element, key: `${kind}:bench-${index}`, name: kind === 'watch' ? `${workspaceId}-city-bench-${index}-${element}` : `${workspaceId}-shipment-bench-${index}`, portId: portIds[index % portIds.length] ?? 'singapore', seed: { ...seed, id: `bench-${index}` } };
  });
};

// ---------------------------------------------------------------- one run

type Timeline = { initMs: number[]; attempts: number; initAcquiredAt: number; readyAt: number; syncQueuedAt: number; syncAcquiredAt: number; syncEndAt: number; syncMs: number; syncStatus: string; attachedAt: number; registerMs: number; joinMs: number };
const blank = (): Timeline => ({ initMs: [], attempts: 0, initAcquiredAt: Number.NaN, readyAt: Number.NaN, syncQueuedAt: Number.NaN, syncAcquiredAt: Number.NaN, syncEndAt: Number.NaN, syncMs: Number.NaN, syncStatus: '-', attachedAt: Number.NaN, registerMs: Number.NaN, joinMs: Number.NaN });

type Result = Readonly<{
  run: Run; skipped?: string; runtimeStartMs: number; coldFirstMs: readonly [number, number]; coldBurstMs: number; warmMs: number;
  readyMs: number; syncDoneMs: number; records: readonly Timeline[]; initQueue: readonly number[]; syncQueue: readonly number[];
  hits: readonly Hit[]; alarmNoise: number; failures: number;
}>;

async function execute(run: Run, root: string, key: string): Promise<Result> {
  const fake = run.relay === 'fake' ? fakeRelay(run.latencyMs, run.history, new Set()) : undefined;
  if (fake) process.env.RELAY_BASE_URL = fake.url; else delete process.env.RELAY_BASE_URL;
  const dataDir = mkdtempSync(join(root, 'data-'));
  const project = throwawayProject(root, { GAZETTEER_LIVE_SOURCES: 'off', ...(fake ? { RELAY_BASE_URL: fake.url } : {}) });
  const started = await timed(() => startLocalActors({
    project, projectId: 'gazetteer-bench', entrypoint: 'src/server/agents/index.ts', dataDir, apiKey: randomUUID(), quiet: process.env.BENCH_LOGS !== '1',
    port: bindInRange(new Set(fake ? [fake.port] : []), port => { Bun.serve({ port, fetch: () => new Response() }).stop(true); return port; }).port,
  }));
  const runtime = started.value;
  try {
    const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion });
    const workspaceId = randomUUID();
    const channel = relayChannel(workspaceId);
    const stub = <A extends object>(actor: 'TrafficWatch' | 'HazardWatch' | 'ShipmentAgent', name: string): A => createActorStub<A>(actor, name, methods, transport);
    const watch = <A extends object>(spec: Spec): A => stub<A>(spec.element === 'traffic' ? 'TrafficWatch' : 'HazardWatch', spec.name);
    const ship = <A extends object>(name: string): A => stub<A>('ShipmentAgent', name);

    // What an actor costs before it touches Relay: the first call loads the class, later calls hit a warm actor.
    const probeName = (kind: string, at: number): string => `${workspaceId}-${kind}-bench-probe-${at}`;
    const probeWatch = (): SplitWatch => stub<SplitWatch>('TrafficWatch', probeName('city', 0));
    const firstWatch = await timed(() => probeWatch().resume());
    const firstShip = await timed(() => ship<ShipmentClient>(probeName('shipment', 0)).resume());
    const burst = await timed(() => Promise.all(Array.from({ length: 10 }, (_, at) => ship<ShipmentClient>(probeName('shipment', at + 1)).resume())));
    const warm = await timed(() => ship<ShipmentClient>(probeName('shipment', 0)).resume());
    const cold = { coldFirstMs: [firstWatch.ms, firstShip.ms] as const, coldBurstMs: burst.ms, warmMs: warm.ms };

    if (run.mode === 'after') {
      const present = await probeWatch().join(workspaceId, key, false).then(() => true, () => false);
      if (!present) {
        return { run, skipped: 'after mode: API not present', runtimeStartMs: started.ms, ...cold, readyMs: Number.NaN, syncDoneMs: Number.NaN, records: [], initQueue: [], syncQueue: [], hits: [], alarmNoise: 0, failures: 0 };
      }
    }

    const specs = specsOf(workspaceId, run.actors);
    const records = new Map(specs.map(spec => [spec.key, blank()]));
    const recordOf = (spec: Spec): Timeline => records.get(spec.key) ?? blank();
    const slots = createLimiter(run.concurrency);
    /** The shared slots, instrumented: how long a call waited for a slot, which is the whole cost of the funnel. */
    const queueWaits = (sink: number[]) => <A>(operation: () => Promise<A>): Promise<A> => {
      const submitted = now();
      return slots(() => { sink.push(now() - submitted); return operation(); });
    };
    const initQueue: number[] = [];
    const syncQueue: number[] = [];
    const startLimit = run.mode === 'before' ? queueWaits(initQueue) : <A>(operation: () => Promise<A>): Promise<A> => operation();
    const syncLimit = queueWaits(syncQueue);
    const relayLimit = queueWaits(initQueue);
    const background: Promise<unknown>[] = [];
    let failures = 0;

    const sync = (spec: Spec, check: () => Promise<RelayOutcome<unknown>>): Promise<void> => {
      const record = recordOf(spec);
      record.syncQueuedAt = now();
      return syncLimit(async () => {
        record.syncAcquiredAt = now();
        const result = await timed(check);
        record.syncMs = result.ms;
        record.syncEndAt = now();
        record.syncStatus = result.value.status;
      }).catch(() => { failures += 1; });
    };

    // before: the server's bringUp, verbatim in shape. Ready means initialised; the history read follows in the background.
    const bringUp = (spec: Spec, initialize: () => Promise<RelayOutcome<null>>, check: () => Promise<RelayOutcome<unknown>>) => async (): Promise<boolean> => {
      const record = recordOf(spec);
      record.attempts += 1;
      record.initAcquiredAt = now();
      const result = await timed(initialize);
      record.initMs.push(result.ms);
      if (result.value.status !== 'ok') return false;
      background.push(sync(spec, check));
      return true;
    };
    const splitUp = (spec: Spec, initialize: () => Promise<RelayOutcome<null>>) => async (): Promise<boolean> => {
      const record = recordOf(spec);
      record.attempts += 1;
      record.initAcquiredAt = now();
      const result = await timed(initialize);
      record.initMs.push(result.ms);
      return result.value.status === 'ok';
    };
    const tasksOf = (): readonly StartupTask[] => {
      const creator = specs[0]?.key;
      return specs.map((spec): StartupTask => {
        const after = spec.index > 0 && creator ? { after: creator } : {};
        const before = <C extends WatchClient | ShipmentClient>(client: C, initialize: (client: C) => Promise<RelayOutcome<null>>): StartupTask =>
          ({ key: spec.key, ...after, run: bringUp(spec, () => initialize(client), () => client.check()) });
        const split = <C extends SplitWatch | SplitShip>(client: C, initialize: (client: C) => Promise<RelayOutcome<null>>): StartupTask =>
          ({ key: spec.key, ...after, run: splitUp(spec, () => initialize(client)) });
        if (run.mode === 'before') {
          return spec.kind === 'watch'
            ? before(watch<WatchClient>(spec), client => client.initialize(workspaceId, spec.portId, key, spec.index === 0))
            : before(ship<ShipmentClient>(spec.name), client => client.initialize(workspaceId, spec.seed, key));
        }
        return spec.kind === 'watch'
          ? split(watch<SplitWatch>(spec), client => client.initialize(workspaceId, spec.portId))
          : split(ship<SplitShip>(spec.name), client => client.initialize(workspaceId, spec.seed));
      });
    };

    // after: once an actor is ready the server registers and joins it through the slots, hands the identity over, and the actor syncs.
    const creatorJoined = deferred();
    const attach = async (spec: Spec): Promise<void> => {
      const record = recordOf(spec);
      if (spec.index > 0) await creatorJoined.promise;
      const client = spec.kind === 'watch' ? watch<SplitWatch>(spec) : ship<SplitWatch>(spec.name);
      const joined = await relayLimit(() => timed(() => client.join(workspaceId, key, spec.index === 0)));
      record.joinMs = joined.ms;
      if (joined.value.status !== 'ok') throw new Error(joined.value.message);
      if (spec.index === 0) creatorJoined.resolve();
      record.attachedAt = now();
      await sync(spec, () => client.check());
    };

    const allReady = deferred();
    let readyCount = 0;
    const startup = createStartup({
      tasksOf, limit: startLimit,
      onReady: (_, taskKey) => {
        const spec = specs.find(candidate => candidate.key === taskKey);
        if (!spec) return;
        recordOf(spec).readyAt = now();
        if (run.mode === 'after') background.push(attach(spec).catch(() => { failures += 1; }));
        readyCount += 1;
        if (readyCount === specs.length) allReady.resolve();
      },
    });
    const t0 = now();
    startup.ensure(workspaceId);
    const deadline = setTimeout(() => allReady.reject(new Error(`not ready within ${run.timeoutMs / 1000}s`)), run.timeoutMs);
    await allReady.promise.finally(() => clearTimeout(deadline));
    const readyMs = now() - t0;
    // The background work is added to while it runs (ready actors queue their sync/attach), so drain until it stops growing.
    const drain = async (seen = 0): Promise<void> => { if (background.length === seen) return; const count = background.length; await Promise.allSettled(background.slice(seen)); return drain(count); };
    await drain();
    startup.close();
    const rebase = (record: Timeline): Timeline => ({
      ...record, initAcquiredAt: record.initAcquiredAt - t0, readyAt: record.readyAt - t0, syncQueuedAt: record.syncQueuedAt - t0,
      syncAcquiredAt: record.syncAcquiredAt - t0, syncEndAt: record.syncEndAt - t0, attachedAt: record.attachedAt - t0,
    });
    const rebased = specs.map(spec => rebase(recordOf(spec)));
    const syncDoneMs = Math.max(...rebased.map(record => record.syncEndAt).filter(Number.isFinite));
    const hits = (fake?.hits ?? []).filter(hit => /^bench-\d+$/.test(hit.actor));
    const lists = hits.filter(hit => hit.route === 'messages.list').length;
    return { run, runtimeStartMs: started.ms, ...cold, readyMs, syncDoneMs, records: rebased, initQueue, syncQueue, hits, alarmNoise: Math.max(0, lists - run.actors), failures };
  } finally {
    await runtime.stop().catch(() => undefined);
    fake?.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- real Relay primitives

type Primitive = Readonly<{ name: string; samples: readonly number[]; failures: readonly string[]; failedMs: readonly number[] }>;
type Attempt<A> = Readonly<{ ms: number; value?: A; failure?: string }>;
const attempt = async <A>(step: () => Promise<A>): Promise<Attempt<A>> => {
  const at = now();
  try { const value = await step(); return { ms: now() - at, value }; } catch (error) { return { ms: now() - at, failure: error instanceof Error ? error.message : 'unknown error' }; }
};
const inSequence = <I, A>(inputs: readonly I[], step: (input: I) => Promise<A>): Promise<readonly Attempt<A>[]> =>
  inputs.reduce<Promise<readonly Attempt<A>[]>>(async (done, input) => [...await done, await attempt(() => step(input))], Promise.resolve([]));
const primitive = <A>(name: string, attempts: readonly Attempt<A>[]): Primitive =>
  ({ name, samples: attempts.filter(entry => entry.failure === undefined).map(entry => entry.ms), failures: attempts.flatMap(entry => entry.failure ?? []), failedMs: attempts.filter(entry => entry.failure !== undefined).map(entry => entry.ms) });
const unwrap = <A>(outcome: RelayOutcome<A>): A => { if (outcome.status === 'unavailable') throw new Error(outcome.message); return outcome.value; };

/** The calls the hypothesis prices, one at a time and in sequence: register, join, the history read, and the creator's list + create. A busy Relay is data here, not an abort. */
async function primitives(key: string, samples: number): Promise<readonly Primitive[]> {
  const channel = relayChannel(randomUUID());
  const indexes = Array.from({ length: samples }, (_, at) => at);
  const creator = await attempt(() => registerParticipant(key, 'bench-prim-creator', channel));
  const created = creator.value ? await attempt(() => joinChannel(creator.value as RelayIdentity, true)) : { ms: Number.NaN, failure: 'no creator identity' };
  const registered = await inSequence(indexes, at => registerParticipant(key, `bench-prim-${at}`, channel));
  const identities = registered.flatMap(entry => entry.value ?? []);
  const joined = await inSequence(identities, identity => joinChannel(identity, false));
  const listed = await inSequence(identities, async identity => unwrap(await readChannel(identity, null)));
  return [
    primitive('register (POST /v1/agents)', registered),
    primitive('join (POST channels/x/join)', joined),
    primitive('history read (GET channels/x/messages)', listed),
    primitive('creator: list + create', [created]),
  ];
}

// ---------------------------------------------------------------- reporting

const routes = ['register', 'channels.list', 'channels.create', 'channels.join', 'messages.list', 'messages.post'] as const;
const report = (result: Result): string => {
  const { run } = result;
  const phase = (pick: (record: Timeline) => number): readonly number[] => result.records.map(pick).filter(Number.isFinite);
  const initWall = result.records.flatMap(record => record.initMs);
  const perActor = (route: string): readonly number[] => Array.from({ length: run.actors }, (_, at) => result.hits.filter(hit => hit.actor === `bench-${at}` && hit.route === route).length);
  const counts = routes.map(route => [route, perActor(route)] as const);
  const totals = Array.from({ length: run.actors }, (_, at) => counts.reduce((sum, [, values]) => sum + (values[at] ?? 0), 0));
  const durations = (route: string): readonly number[] => result.hits.filter(hit => hit.route === route).map(hit => hit.endedAt - hit.startedAt);
  const lines = [
    `--- ${run.relay} ${run.mode} N=${run.actors} k=${run.concurrency}${run.relay === 'fake' ? ` latency=${run.latencyMs}ms` : ''}${run.history ? ` history=${run.history}` : ''}`,
    `runtime start ${ms(result.runtimeStartMs)}; cold first call watch ${ms(result.coldFirstMs[0])} ship ${ms(result.coldFirstMs[1])}; 10 fresh ships in parallel ${ms(result.coldBurstMs)}; warm repeat ${ms(result.warmMs)}`,
    `all ready ${ms(result.readyMs)}; all history reads done ${ms(result.syncDoneMs)}; failures ${result.failures}; retried tasks ${result.records.filter(record => record.attempts > 1).length}`,
    table([
      ['phase (p50 / p95 / max)', 'value'],
      ['ready time per actor', spread(phase(record => record.readyAt))],
      ['initialize RPC (register + join + actor)', spread(initWall)],
      ['  of which register, fake-side', spread(durations('register'))],
      ['  of which join/create, fake-side', spread([...durations('channels.join'), ...durations('channels.create'), ...durations('channels.list')])],
      ['queue wait for a slot, initialize', spread(result.initQueue)],
      ['queue wait for a slot, history read', spread(result.syncQueue)],
      ['history read RPC (check)', spread(phase(record => record.syncMs))],
      ['history read done, per actor (since t0)', spread(phase(record => record.syncEndAt))],
      ...(run.mode === 'after' ? [['attached (adopt done) per actor', spread(phase(record => record.attachedAt))], ['server register / join', `${spread(phase(record => record.registerMs))}  |  ${spread(phase(record => record.joinMs))}`]] : []),
    ]),
  ];
  if (run.relay === 'fake') {
    lines.push(table([
      ['relay requests', 'total', 'per actor (mean)', 'min..max per actor'],
      ...counts.map(([route, values]) => [route, String(values.reduce((a, b) => a + b, 0)), (values.reduce((a, b) => a + b, 0) / run.actors).toFixed(2), `${Math.min(...values)}..${Math.max(...values)}`]),
      ['all', String(totals.reduce((a, b) => a + b, 0)), (totals.reduce((a, b) => a + b, 0) / run.actors).toFixed(2), `${Math.min(...totals)}..${Math.max(...totals)}`],
    ]));
    if (result.alarmNoise > 0) lines.push(`(${result.alarmNoise} extra messages.list hits beyond one per actor: alarms fired during the run)`);
  }
  return lines.join('\n');
};

const summary = (results: readonly Result[]): string => table([
  ['relay', 'mode', 'N', 'k', 'lat', 'runtime', 'ready', 'history done', 'queue p50/max (init)', 'req/actor', 'model ready', 'model done'],
  ...results.filter(result => !result.skipped).map(result => {
    const { run } = result;
    const requests = result.hits.length;
    const { actors, concurrency, latencyMs } = run;
    // Creator: register, list, create in sequence; every other actor: register and join (two calls) through k slots; then one history read each.
    const modelReady = latencyMs * (3 + Math.ceil((actors - 1) / concurrency) * 2);
    const modelDone = Math.max(modelReady, latencyMs * (3 * actors + 1) / concurrency);
    return [
      run.relay, run.mode, String(run.actors), String(run.concurrency), run.relay === 'fake' ? ms(run.latencyMs) : 'real', ms(result.runtimeStartMs), ms(result.readyMs), ms(result.syncDoneMs),
      `${ms(quantile(result.initQueue, 0.5))}/${ms(Math.max(...result.initQueue))}`, run.relay === 'fake' ? (requests / run.actors).toFixed(2) : 'n/a', ...(run.relay === 'fake' && latencyMs > 0 ? [ms(modelReady), ms(modelDone)] : ['-', '-']),
    ];
  }),
]);

// ---------------------------------------------------------------- main

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const runs = plan(options);
  if (options.relay === 'real') {
    if (runs.length > 2) throw new Error('real Relay costs the sponsor rate limit: at most two real runs');
    if (runs.some(run => run.actors !== 5 && run.actors !== 25)) throw new Error('real Relay runs use N=5 or N=25 only');
  }
  const root = mkdtempSync(join(process.env.BENCH_TMPDIR ?? tmpdir(), 'bench-startup-'));
  mkdirSync(root, { recursive: true });
  const key = workspaceKeyOf();
  const results: Result[] = [];
  try {
    for (const run of runs) {
      const prims = options.relay === 'real' ? await primitives(key, 5) : [];
      if (prims.length > 0) console.log(`--- real Relay primitives, one call at a time\n${table([['call', 'ok', 'p50 / p95 / max', 'failures'], ...prims.map(prim => [prim.name, String(prim.samples.length), spread(prim.samples), prim.failures.length === 0 ? '0' : `${prim.failures.length} (after ${spread(prim.failedMs)}): ${prim.failures[0]}`])])}`);
      const result = await execute(run, root, key);
      results.push(result);
      console.log(result.skipped ?? report(result));
    }
    if (results.some(result => !result.skipped)) console.log(`\n=== summary\n${summary(results)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
