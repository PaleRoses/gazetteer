import type { Dashboard } from '../../core/types';
import type { WorkspaceEvent, Subscribe } from '../runtime/hub';

const retryMs = 3000;
const pingMs = 20_000;
export const preamble = `retry: ${retryMs}\n\n`;
export const pingFrame = ': ping\n\n';
/** JSON.stringify never emits a raw newline, so one data line always carries the whole payload. */
export const frame = (event: WorkspaceEvent): string => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
export type EventsOptions = Readonly<{
  subscribe: Subscribe;
  /** Sent once after connecting so a reconnecting browser resynchronises (events are never replayed). */
  snapshot?: (workspaceId: string) => Promise<Dashboard | null>;
  pingMs?: number;
}>;

const eventStreamHeaders = {
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
