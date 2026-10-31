import type { Comment, Dashboard } from '../../shared';

export type WorkspaceEvent =
  | Readonly<{ event: 'dashboard'; data: Dashboard }>
  | Readonly<{ event: 'comment'; data: Readonly<{ shipmentId: string; comment: Comment }> }>;
export type Listener = (event: WorkspaceEvent) => void;
export type Subscribe = (workspaceId: string, listener: Listener) => () => void;

export const retryMs = 3000;
export const pingMs = 20_000;
export const preamble = `retry: ${retryMs}\n\n`;
export const pingFrame = ': ping\n\n';
/** JSON.stringify never emits a raw newline, so one data line always carries the whole payload. */
export const frame = (event: WorkspaceEvent): string => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;

export type Hub = Readonly<{
  subscribe: Subscribe;
  publish(workspaceId: string, event: WorkspaceEvent): void;
  /** Publishes only when the shipment state differs from the last dashboard published for the workspace. */
  publishDashboard(workspaceId: string, dashboard: Dashboard): boolean;
  subscribers(workspaceId: string): number;
  /** Workspaces with at least one open stream. */
  active(): readonly string[];
}>;

const signature = (dashboard: Dashboard): string => JSON.stringify({ ...dashboard, updatedAt: null });

export function createHub(): Hub {
  const listeners = new Map<string, ReadonlySet<Listener>>();
  const published = new Map<string, string>();
  const subscribe: Subscribe = (workspaceId, listener) => {
    listeners.set(workspaceId, new Set([...(listeners.get(workspaceId) ?? []), listener]));
    return () => {
      const remaining = new Set([...(listeners.get(workspaceId) ?? [])].filter(value => value !== listener));
      if (remaining.size === 0) listeners.delete(workspaceId); else listeners.set(workspaceId, remaining);
    };
  };
  const publish = (workspaceId: string, event: WorkspaceEvent): void => {
    [...(listeners.get(workspaceId) ?? [])].forEach(listener => {
      try { listener(event); } catch { /* one dead consumer never starves the others */ }
    });
  };
  return {
    subscribe, publish,
    publishDashboard: (workspaceId, dashboard) => {
      const next = signature(dashboard);
      if (published.get(workspaceId) === next) return false;
      published.set(workspaceId, next);
      publish(workspaceId, { event: 'dashboard', data: dashboard });
      return true;
    },
    subscribers: workspaceId => listeners.get(workspaceId)?.size ?? 0,
    active: () => [...listeners.keys()],
  };
}

export type EventsOptions = Readonly<{
  subscribe: Subscribe;
  /** Sent once after connecting so a reconnecting browser resynchronises (events are never replayed). */
  snapshot?: (workspaceId: string) => Promise<Dashboard | null>;
  pingMs?: number;
}>;

export const eventStreamHeaders = {
  'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
  'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff',
} as const;

/** Mount behind the membership check: `GET /api/workspaces/:id/events`. */
export const createEventsHandler = ({ subscribe, snapshot, pingMs: interval = pingMs }: EventsOptions) =>
  (request: Request, workspaceId: string): Response => {
    const encoder = new TextEncoder();
    let release: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let open = true;
        let delivered = false;
        const send = (text: string): void => {
          if (!open) return;
          try { controller.enqueue(encoder.encode(text)); } catch { release(); }
        };
        const unsubscribe = subscribe(workspaceId, event => {
          delivered = delivered || event.event === 'dashboard';
          send(frame(event));
        });
        const timer = setInterval(() => send(pingFrame), interval);
        release = () => {
          if (!open) return;
          open = false;
          clearInterval(timer);
          unsubscribe();
          try { controller.close(); } catch { /* already closed by the consumer */ }
        };
        request.signal.addEventListener('abort', release, { once: true });
        send(preamble);
        void snapshot?.(workspaceId).then(dashboard => {
          if (dashboard && !delivered) send(frame({ event: 'dashboard', data: dashboard }));
        }).catch(() => undefined);
      },
      cancel: () => release(),
    });
    return new Response(body, { headers: eventStreamHeaders });
  };
