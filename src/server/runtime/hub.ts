import type { Comment, Dashboard } from '../../core/types';

export type WorkspaceEvent =
  | Readonly<{ event: 'dashboard'; data: Dashboard }>
  | Readonly<{ event: 'comment'; data: Readonly<{ shipmentId: string; comment: Comment }> }>;

type Listener = (event: WorkspaceEvent) => void;

export type Subscribe = (workspaceId: string, listener: Listener) => () => void;

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
