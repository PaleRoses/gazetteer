/** Releases a slot to the next waiter directly, so the cap holds even between a release and the waiter resuming. */
export function createLimiter(max: number): <A>(operation: () => Promise<A>) => Promise<A> {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async operation => {
    if (active >= max) await new Promise<void>(resume => waiting.push(resume)); else active += 1;
    try { return await operation(); } finally {
      const next = waiting.shift();
      if (next) next(); else active -= 1;
    }
  };
}

export type StartupTask = Readonly<{
  key: string;
  /** True once the actor is ready: initialised from local state alone, never waiting on Relay. False or a throw means "try again later". */
  run: () => Promise<boolean>;
  /** The actor's Relay membership (register, join, history): background work on the shared slots, retried with backoff, never part of readiness. */
  follow?: () => Promise<boolean>;
  /** Another task of the same workspace whose membership must complete first (the channel creator before every joiner). */
  after?: string;
}>;
type StartupStatus = Readonly<{ ready: number; joined: number; total: number; complete: boolean }>;
export type Startup = Readonly<{
  /** Single-flight per workspace: the first call starts the work in the background, later calls are free. */
  ensure(workspaceId: string): void;
  /** Reconcile explicit fleet edits without restarting ready actors. */
  reconcile(workspaceId: string): void;
  status(workspaceId: string): StartupStatus;
  isStarted(workspaceId: string): boolean;
  isReady(workspaceId: string, key: string): boolean;
  close(): void;
}>;
export type StartupOptions = Readonly<{
  tasksOf: (workspaceId: string) => readonly StartupTask[];
  limit: <A>(operation: () => Promise<A>) => Promise<A>;
  onReady?: (workspaceId: string, key: string) => void;
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}>;

const defaultSleep = (ms: number): Promise<void> => new Promise(done => { setTimeout(done, ms).unref?.(); });

/** Initialises a workspace's actors in the background: bounded by the shared limiter, dependencies respected, failures retried with growing backoff. */
export function createStartup({ tasksOf, limit, onReady = () => undefined, delaysMs = [1000, 2000, 5000, 15_000], sleep = defaultSleep }: StartupOptions): Startup {
  const workspaces = new Map<string, Readonly<{ keys: readonly string[]; ready: Set<string>; joined: Set<string> }>>();
  const gates = new Map<string, Promise<void>>();
  let closed = false;
  const local = createLimiter(64);
  const settle = async (step: () => Promise<boolean>, within: typeof limit, attempt: number): Promise<void> => {
    if (closed) return;
    const ok = await within(() => step().catch(() => false));
    if (ok) return;
    await sleep(delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 0);
    return settle(step, within, attempt + 1);
  };
  const reconcile = (workspaceId: string): void => {
    if (closed) return;
    const tasks = tasksOf(workspaceId);
    const ready = workspaces.get(workspaceId)?.ready ?? new Set<string>();
    const joined = workspaces.get(workspaceId)?.joined ?? new Set<string>();
    workspaces.set(workspaceId, { keys: tasks.map(task => task.key), ready, joined });
    tasks.forEach(task => {
      if (gates.has(`${workspaceId}\u0000${task.key}`)) return;
      const gate = (async () => {
        await settle(task.run, local, 0);
        if (closed) return;
        ready.add(task.key);
        onReady(workspaceId, task.key);
        if (task.after) await gates.get(`${workspaceId}\u0000${task.after}`);
        await settle(task.follow ?? (async () => true), limit, 0);
        if (!closed) joined.add(task.key);
      })();
      gates.set(`${workspaceId}\u0000${task.key}`, gate);
    });
  };
  return {
    ensure: workspaceId => { if (!workspaces.has(workspaceId)) reconcile(workspaceId); },
    reconcile,
    status: workspaceId => {
      const entry = workspaces.get(workspaceId);
      const count = entry?.keys.filter(key => entry.ready.has(key)).length ?? 0;
      return { ready: count, joined: entry?.keys.filter(key => entry.joined.has(key)).length ?? 0, total: entry?.keys.length ?? 0, complete: entry !== undefined && count === entry.keys.length };
    },
    isStarted: workspaceId => workspaces.has(workspaceId),
    isReady: (workspaceId, key) => workspaces.get(workspaceId)?.ready.has(key) ?? false,
    close: () => { closed = true; },
  };
}
