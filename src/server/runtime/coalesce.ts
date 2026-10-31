/** At most one run per key at a time; triggers during a run collapse into exactly one trailing run. */
export function createCoalescer(run: (key: string) => Promise<void>, onError: (error: unknown) => void = () => undefined): (key: string) => Promise<void> {
  const inflight = new Map<string, Promise<void>>();
  const pending = new Set<string>();
  const drain = async (key: string): Promise<void> => {
    pending.delete(key);
    await (async () => run(key))().catch(onError);
    if (pending.has(key)) return drain(key);
    inflight.delete(key);
  };
  return key => {
    const running = inflight.get(key);
    if (running) { pending.add(key); return running; }
    const started = drain(key);
    inflight.set(key, started);
    return started;
  };
}
