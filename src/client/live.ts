import { createEffect, createSignal, on, onCleanup, type Accessor } from 'solid-js';
import type { Dashboard } from '../core/types';
import { dashboardSchema, request, type ApiResult } from './api';
import { changesBetween, isCurrent, parseCommentEvent, parseDashboardEvent, type Change, type CommentEvent } from './feed';

export type FeedMode = 'connecting' | 'live' | 'polling';
const POLL_MS = 5_000;
const RETRY_STREAM_MS = 30_000;
const SNAPSHOT_GRACE_MS = 8_000;
const COMMENT_BACKLOG = 50;
type WorkspaceEvents = Pick<EventSource, 'readyState' | 'close' | 'CLOSED'> & Readonly<{
  addEventListener: (kind: string, listener: (event: Event) => void) => void;
}>;
type FeedEffects = Readonly<{
  read: (path: string, signal: AbortSignal) => Promise<ApiResult<Dashboard>>;
  stream: (path: string) => WorkspaceEvents;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout> | undefined) => void;
}>;
const browserEffects: FeedEffects = {
  read: (path, signal) => request(path, dashboardSchema, undefined, signal),
  stream: path => new EventSource(path, { withCredentials: true }),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: timer => globalThis.clearTimeout(timer),
};

export type Feed = Readonly<{
  dashboard: Accessor<Dashboard | null>; mode: Accessor<FeedMode>; error: Accessor<string | null>;
  changes: Accessor<readonly Change[]>; comments: Accessor<readonly CommentEvent[]>;
  accept: (incoming: Dashboard) => void;
  /** One immediate dashboard read, for the Retry control; it writes through the same guard as the poll. */
  retry: () => void;
}>;

/**
 * One writer of dashboard state at a time: the event stream while it delivers (the server sends a snapshot on connect),
 * the 5 s poll only while the stream is absent, down, or silent past the snapshot grace period.
 * `paused` holds feed writes while the user's own request is in flight; its response is applied through `accept`.
 */
export function createWorkspaceFeed(workspaceId: string, paused: Accessor<boolean>, effects: FeedEffects = browserEffects): Feed {
  const [dashboard, setDashboard] = createSignal<Dashboard | null>(null);
  const [mode, setMode] = createSignal<FeedMode>('connecting');
  const [error, setError] = createSignal<string | null>(null);
  const [changes, setChanges] = createSignal<readonly Change[]>([]);
  const [comments, setComments] = createSignal<readonly CommentEvent[]>([]);
  const [pollOwner, setPollOwner] = createSignal<AbortController | null>(null);

  const accept = (incoming: Dashboard): void => {
    const held = dashboard();
    if (!isCurrent(held, incoming)) return;
    const moved = changesBetween(held, incoming);
    setDashboard(incoming);
    if (moved.length > 0) setChanges(moved);
  };

  const controller = new AbortController();
  let source: WorkspaceEvents | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const base = `/api/workspaces/${workspaceId}`;

  const fetchOnce = (signal: AbortSignal = controller.signal): Promise<void> => effects.read(`${base}/dashboard`, AbortSignal.any([controller.signal, signal])).then(result => {
    if (controller.signal.aborted || signal.aborted) return;
    if (result.ok) { setError(null); if (!paused()) accept(result.value); } else setError(result.error);
  });
  const poll = (owner: AbortController): void => { void fetchOnce(owner.signal).then(() => { if (!controller.signal.aborted && !owner.signal.aborted) pollTimer = effects.setTimeout(() => poll(owner), POLL_MS); }); };
  const startPolling = (): void => {
    if (pollTimer !== undefined) return;
    const owner = new AbortController();
    setPollOwner(owner); setMode('polling'); pollTimer = effects.setTimeout(() => poll(owner), 0);
  };
  const stopPolling = (): void => { pollOwner()?.abort(); setPollOwner(null); effects.clearTimeout(pollTimer); pollTimer = undefined; };

  const connect = (): void => {
    if (controller.signal.aborted) return;
    const stream = effects.stream(`${base}/events`);
    source = stream;
    stream.addEventListener('open', () => {
      stopPolling(); setMode('live'); setError(null);
      graceTimer = effects.setTimeout(startPolling, SNAPSHOT_GRACE_MS);
    });
    stream.addEventListener('dashboard', event => {
      const parsed = parseDashboardEvent((event as MessageEvent).data);
      if (!parsed) return;
      effects.clearTimeout(graceTimer); stopPolling(); setMode('live'); setError(null);
      if (!paused()) accept(parsed);
    });
    stream.addEventListener('comment', event => {
      const parsed = parseCommentEvent((event as MessageEvent).data);
      if (parsed) setComments(previous => [...previous.slice(-(COMMENT_BACKLOG - 1)), parsed]);
    });
    stream.addEventListener('error', () => {
      effects.clearTimeout(graceTimer);
      startPolling();
      if (stream.readyState === stream.CLOSED) { stream.close(); retryTimer = effects.setTimeout(connect, RETRY_STREAM_MS); }
    });
  };

  startPolling();
  connect();
  onCleanup(() => { controller.abort(); source?.close(); stopPolling(); effects.clearTimeout(retryTimer); effects.clearTimeout(graceTimer); });

  return { dashboard, mode, error, changes, comments, accept, retry: () => { void fetchOnce(); } };
}

/** True for a few seconds after `value` changes; never on first read. */
export function createChangeFlash(value: Accessor<string>, holdMs = 4_500): Accessor<boolean> {
  const [flashing, setFlashing] = createSignal(false);
  createEffect(on(value, () => {
    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), holdMs);
    onCleanup(() => window.clearTimeout(timer));
  }, { defer: true }));
  return flashing;
}
