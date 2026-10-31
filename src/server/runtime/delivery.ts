import { mergeInbox, type Inbox } from '../relay/inbox';

type Actor = { mark: number; flying: Promise<void> | null; retrying: boolean; failures: number; send: (batch: Inbox) => Promise<void>; wants: (batch: Inbox) => boolean };
export type Delivery = Readonly<{
  /** What the server heard or authored in this workspace; actors are handed it from their own watermark, however many sends failed before. */
  record(workspaceId: string, batch: Inbox): void;
  /**
   * Brings one actor up to date: sends everything recorded after its watermark, in one cumulative batch, and advances the watermark only
   * when the send succeeded. A failure schedules its own capped retry, so nothing waits for the next message to arrive. Single-flight per actor.
   */
  deliver(workspaceId: string, actor: string, send: (batch: Inbox) => Promise<void>, wants?: (batch: Inbox) => boolean): Promise<void>;
  close(): void;
}>;
export type DeliveryOptions = Readonly<{ retainBatches?: number; delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> }>;

const defaultSleep = (ms: number): Promise<void> => new Promise(done => { setTimeout(done, ms).unref?.(); });
const key = (workspaceId: string, actor: string): string => `${workspaceId}\u0000${actor}`;

/**
 * The server's high-water mark per actor. Merging is idempotent by id on the actor's side, so re-sending from the mark is always safe;
 * an actor whose mark fell off the retained log catches up from Relay at its next resume, like any restarted actor.
 */
export function createDelivery({ retainBatches = 200, delaysMs = [1000, 2000, 5000, 15_000], sleep = defaultSleep }: DeliveryOptions = {}): Delivery {
  const logs = new Map<string, { seq: number; batches: readonly Readonly<{ seq: number; batch: Inbox }>[] }>();
  const actors = new Map<string, Actor>();
  let closed = false;
  const logOf = (workspaceId: string) => logs.get(workspaceId) ?? { seq: 0, batches: [] };
  const since = (workspaceId: string, mark: number): Inbox =>
    logOf(workspaceId).batches.filter(entry => entry.seq > mark).reduce<Inbox>((all, entry) => mergeInbox(all, entry.batch), { board: [], disruptions: [] });

  const flush = async (workspaceId: string, actor: string, state: Actor): Promise<void> => {
    const upTo = logOf(workspaceId).seq;
    const batch = since(workspaceId, state.mark);
    if (batch.board.length + batch.disruptions.length === 0 || !state.wants(batch)) return;
    const sent = await state.send(batch).then(() => true, () => false);
    if (sent) {
      state.mark = upTo;
      state.failures = 0;
      return flush(workspaceId, actor, state);
    }
    const delay = delaysMs[Math.min(state.failures, delaysMs.length - 1)] ?? 0;
    state.failures += 1;
    if (state.retrying || closed) return;
    state.retrying = true;
    /** The retry waits for the flight that scheduled it to land, or `deliver` would hand back that flight instead of starting one. */
    void sleep(delay).then(() => state.flying).then(() => { state.retrying = false; return closed ? undefined : deliver(workspaceId, actor, state.send, state.wants); });
  };
  const deliver: Delivery['deliver'] = (workspaceId, actor, send, wants = () => true) => {
    const state = actors.get(key(workspaceId, actor)) ?? { mark: 0, flying: null, retrying: false, failures: 0, send, wants };
    state.send = send;
    state.wants = wants;
    actors.set(key(workspaceId, actor), state);
    if (state.flying) return state.flying;
    const flying = flush(workspaceId, actor, state).finally(() => { state.flying = null; });
    state.flying = flying;
    return flying;
  };
  return {
    record: (workspaceId, batch) => {
      const log = logOf(workspaceId);
      const seq = log.seq + 1;
      logs.set(workspaceId, { seq, batches: [...log.batches, { seq, batch }].slice(-retainBatches) });
    },
    deliver,
    close: () => { closed = true; },
  };
}
