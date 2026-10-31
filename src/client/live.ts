import { useEffect, useRef, useState } from 'react';
import type { Dashboard } from '../shared';
import { dashboardSchema, request } from './api';
import { changesBetween, isCurrent, parseCommentEvent, parseDashboardEvent, type Change, type CommentEvent } from './feed';

export type FeedMode = 'connecting' | 'live' | 'polling';
const POLL_MS = 5_000;
const RETRY_STREAM_MS = 30_000;
const SNAPSHOT_GRACE_MS = 8_000;
const COMMENT_BACKLOG = 50;

export type Feed = Readonly<{
  dashboard: Dashboard | null; mode: FeedMode; error: string | null; changes: readonly Change[]; comments: readonly CommentEvent[];
  accept: (incoming: Dashboard) => void;
}>;

/**
 * One writer at a time: the stream while it delivers (the server sends a snapshot on connect), the 5 s poll only while
 * the stream is absent, down, or silent past the snapshot grace period.
 */
export function useWorkspaceFeed(workspaceId: string, paused: boolean): Feed {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [mode, setMode] = useState<FeedMode>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<readonly Change[]>([]);
  const [comments, setComments] = useState<readonly CommentEvent[]>([]);
  const held = useRef<Dashboard | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const accept = useRef((incoming: Dashboard): void => {
    if (!isCurrent(held.current, incoming)) return;
    const moved = changesBetween(held.current, incoming);
    held.current = incoming;
    setDashboard(incoming);
    if (moved.length > 0) setChanges(moved);
  }).current;

  useEffect(() => {
    const controller = new AbortController();
    let source: EventSource | undefined;
    let pollTimer: number | undefined;
    let retryTimer: number | undefined;
    let graceTimer: number | undefined;
    const base = `/api/workspaces/${workspaceId}`;

    const fetchOnce = (): Promise<void> => request(`${base}/dashboard`, dashboardSchema, undefined, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) { setError(null); if (!pausedRef.current) accept(result.value); } else setError(result.error);
    });
    const poll = (): void => { void fetchOnce().then(() => { if (!controller.signal.aborted && pollTimer !== undefined) pollTimer = window.setTimeout(poll, POLL_MS); }); };
    const startPolling = (): void => { if (pollTimer === undefined) { setMode('polling'); pollTimer = window.setTimeout(poll, 0); } };
    const stopPolling = (): void => { window.clearTimeout(pollTimer); pollTimer = undefined; };

    const connect = (): void => {
      if (controller.signal.aborted) return;
      const stream = new EventSource(`${base}/events`, { withCredentials: true });
      source = stream;
      stream.addEventListener('open', () => {
        stopPolling(); setMode('live'); setError(null);
        graceTimer = window.setTimeout(startPolling, SNAPSHOT_GRACE_MS);
      });
      stream.addEventListener('dashboard', event => {
        const parsed = parseDashboardEvent((event as MessageEvent).data);
        if (!parsed) return;
        window.clearTimeout(graceTimer); stopPolling(); setMode('live'); setError(null);
        if (!pausedRef.current) accept(parsed);
      });
      stream.addEventListener('comment', event => {
        const parsed = parseCommentEvent((event as MessageEvent).data);
        if (parsed) setComments(previous => [...previous.slice(-(COMMENT_BACKLOG - 1)), parsed]);
      });
      stream.addEventListener('error', () => {
        window.clearTimeout(graceTimer);
        startPolling();
        if (stream.readyState === EventSource.CLOSED) { stream.close(); retryTimer = window.setTimeout(connect, RETRY_STREAM_MS); }
      });
    };

    startPolling();
    connect();
    return () => { controller.abort(); source?.close(); stopPolling(); window.clearTimeout(retryTimer); window.clearTimeout(graceTimer); };
  }, [workspaceId, accept]);

  return { dashboard, mode, error, changes, comments, accept };
}

/** True for a few seconds after `value` changes while mounted; never on first render. */
export function useChangeFlash(value: string, holdMs = 4_500): boolean {
  const previous = useRef(value);
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (previous.current === value) return;
    previous.current = value;
    setFlashing(true);
    const timer = window.setTimeout(() => setFlashing(false), holdMs);
    return () => window.clearTimeout(timer);
  }, [value, holdMs]);
  return flashing;
}
