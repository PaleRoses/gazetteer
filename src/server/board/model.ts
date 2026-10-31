import type { RelayMessage } from '@agent-relay/sdk';
import type { BoardMessage } from '../../board';
import { compareMessages, type ListPage } from '../realtime/cursor';
import { boardFrom } from './transport';

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

/** Per-workspace read model behind Dashboard.board. `hydrate` runs once per workspace until it succeeds. */
export function createBoardModel(hydrate: (workspaceId: string) => Promise<readonly BoardMessage[]>) {
  const boards = new Map<string, readonly BoardMessage[]>();
  const hydrated = new Set<string>();
  const ingest = (workspaceId: string, incoming: readonly BoardMessage[]): boolean => {
    const current = boards.get(workspaceId) ?? [];
    const next = mergeBoard(current, incoming);
    const changed = next.length !== current.length || next.some((message, index) => message.id !== current[index]?.id);
    boards.set(workspaceId, next);
    return changed;
  };
  return {
    ingest,
    /** Undefined until the workspace has been read once: absence must not read as "the board is empty". */
    board: async (workspaceId: string): Promise<readonly BoardMessage[] | undefined> => {
      if (!hydrated.has(workspaceId)) {
        const history = await hydrate(workspaceId).then(messages => messages, () => undefined);
        if (history) { ingest(workspaceId, history); hydrated.add(workspaceId); }
      }
      return hydrated.has(workspaceId) ? boards.get(workspaceId) ?? [] : undefined;
    },
  };
}
