import type { RelayMessage } from '@agent-relay/sdk';
import type { BoardMessage } from '../../core/board';
import { compareMessages, type ListPage } from './cursor';
import { boardFrom } from './board';

export const boardCapacity = 100;

const byTime = (left: BoardMessage, right: BoardMessage): number => (left.at < right.at ? -1 : left.at > right.at ? 1 : left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** Chronological (oldest first), distinct by id, the newest `capacity` kept. Order-insensitive, so live and hydrated feeds may interleave. */
export const mergeBoard = (current: readonly BoardMessage[], incoming: readonly BoardMessage[], capacity = boardCapacity): readonly BoardMessage[] =>
  [...new Map([...current, ...incoming].map(message => [message.id, message])).values()].toSorted(byTime).slice(-capacity);

/**
 * Walk the channel newest-first until `capacity` board messages are found or history ends.
 * The page budget bounds the cost of a channel dominated by other traffic.
 */
export async function recentBoard(list: ListPage<RelayMessage>, capacity = boardCapacity, limit = 100, maxPages = 5): Promise<readonly BoardMessage[]> {
  const walk = async (before: string | undefined, found: readonly BoardMessage[], pages: number): Promise<readonly BoardMessage[]> => {
    const page = await list({ limit, ...(before ? { before } : {}) });
    const merged = mergeBoard(found, page.flatMap(message => boardFrom(message) ?? []), capacity);
    const oldest = page.toSorted(compareMessages)[0];
    return page.length < limit || !oldest || merged.length >= capacity || pages + 1 >= maxPages ? merged : walk(oldest.messageId, merged, pages + 1);
  };
  return walk(undefined, [], 0);
}

export type BoardModelOptions = Readonly<{
  /** Called once a workspace's history has been read, so a pushed dashboard can gain its board. */
  onHydrated?: (workspaceId: string) => void;
  retryAfterMs?: number;
  now?: () => number;
}>;

/** Per-workspace read model behind Dashboard.board. History is read in the background, once per workspace, and never blocks a caller. */
export function createBoardModel(hydrate: (workspaceId: string) => Promise<readonly BoardMessage[]>, { onHydrated = () => undefined, retryAfterMs = 5000, now = Date.now }: BoardModelOptions = {}) {
  const boards = new Map<string, readonly BoardMessage[]>();
  const hydrated = new Set<string>();
  const inflight = new Set<string>();
  const failedAt = new Map<string, number>();
  const ingest = (workspaceId: string, incoming: readonly BoardMessage[]): boolean => {
    const current = boards.get(workspaceId) ?? [];
    const next = mergeBoard(current, incoming);
    const changed = next.length !== current.length || next.some((message, index) => message.id !== current[index]?.id);
    boards.set(workspaceId, next);
    return changed;
  };
  const warm = (workspaceId: string): void => {
    const failed = failedAt.get(workspaceId);
    if (hydrated.has(workspaceId) || inflight.has(workspaceId) || (failed !== undefined && now() - failed < retryAfterMs)) return;
    inflight.add(workspaceId);
    void hydrate(workspaceId).then(history => {
      ingest(workspaceId, history);
      hydrated.add(workspaceId);
      failedAt.delete(workspaceId);
      onHydrated(workspaceId);
    }, () => { failedAt.set(workspaceId, now()); }).finally(() => { inflight.delete(workspaceId); });
  };
  return {
    ingest,
    /** Undefined until the workspace has been read once: absence must not read as "the board is empty". Starts the read when needed. */
    board: (workspaceId: string): readonly BoardMessage[] | undefined => {
      warm(workspaceId);
      return hydrated.has(workspaceId) ? boards.get(workspaceId) ?? [] : undefined;
    },
  };
}
