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
  /** Another task of the same workspace that must be ready first (the channel creator before every joiner). */
  after?: string;
  /** True once the actor is ready; false or a throw means "try again later". */
  run: () => Promise<boolean>;
}>;
type StartupStatus = Readonly<{ ready: number; total: number; complete: boolean }>;
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
  const workspaces = new Map<string, Readonly<{ keys: readonly string[]; ready: Set<string> }>>();
  const gates = new Map<string, Promise<void>>();
  let closed = false;
  const settle = async (workspaceId: string, task: StartupTask, attempt: number): Promise<void> => {
    if (closed) return;
    const ok = await limit(() => task.run().catch(() => false));
    if (ok) return;
    await sleep(delaysMs[Math.min(attempt, delaysMs.length - 1)] ?? 0);
    return settle(workspaceId, task, attempt + 1);
  };
  const reconcile = (workspaceId: string): void => {
    if (closed) return;
    const tasks = tasksOf(workspaceId);
    const ready = workspaces.get(workspaceId)?.ready ?? new Set<string>();
    workspaces.set(workspaceId, { keys: tasks.map(task => task.key), ready });
    tasks.forEach(task => {
      if (gates.has(`${workspaceId}\u0000${task.key}`)) return;
      const gate = (async () => {
        if (task.after) await gates.get(`${workspaceId}\u0000${task.after}`);
        await settle(workspaceId, task, 0);
        if (closed) return;
        ready.add(task.key);
        onReady(workspaceId, task.key);
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
      return { ready: count, total: entry?.keys.length ?? 0, complete: entry !== undefined && count === entry.keys.length };
    },
    isStarted: workspaceId => workspaces.has(workspaceId),
    isReady: (workspaceId, key) => workspaces.get(workspaceId)?.ready.has(key) ?? false,
    close: () => { closed = true; },
  };
}
