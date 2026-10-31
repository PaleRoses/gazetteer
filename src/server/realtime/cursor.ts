import type { RelayMessage } from '@agent-relay/sdk';

export type Message = Pick<RelayMessage, 'messageId' | 'createdAt' | 'metadata'>;
export type Cursor = Readonly<{ messageId: string; createdAt: string | null }>;
export type PageRequest = Readonly<{ limit: number; before?: string; after?: string }>;
export type ListPage<M extends Message> = (request: PageRequest) => Promise<readonly M[]>;
type Key = Readonly<{ messageId: string; createdAt?: string | null }>;

const digits = /^\d+$/;
const compareDigits = (left: string, right: string): number => {
  const [a, b] = [left.replace(/^0+(?=\d)/, ''), right.replace(/^0+(?=\d)/, '')];
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
};
const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/** Relay ids are monotonic snowflakes; anything else falls back to (createdAt, id). */
export const compareMessages = (left: Key, right: Key): number =>
  digits.test(left.messageId) && digits.test(right.messageId)
    ? compareDigits(left.messageId, right.messageId)
    : compareText(left.createdAt ?? '', right.createdAt ?? '') || compareText(left.messageId, right.messageId);

const cursorOf = (message: Key): Cursor => ({ messageId: message.messageId, createdAt: message.createdAt ?? null });
const distinct = <M extends Message>(messages: readonly M[]): readonly M[] => [...new Map(messages.map(message => [message.messageId, message])).values()];

export type Advance<M extends Message> = Readonly<{ fresh: readonly M[]; cursor: Cursor | null }>;

/**
 * Pure step: the messages of any page (any order, overlapping, replayed) that lie strictly past the cursor,
 * oldest first, and the cursor moved to the newest of them. Applying the same page twice yields nothing new.
 */
export const advance = <M extends Message>(cursor: Cursor | null, page: readonly M[]): Advance<M> => {
  const fresh = distinct(page).filter(message => cursor === null || compareMessages(message, cursor) > 0).toSorted(compareMessages);
  const newest = fresh.at(-1);
  return { fresh, cursor: newest ? cursorOf(newest) : cursor };
};

export type Collected<M extends Message> = Readonly<{ messages: readonly M[]; complete: boolean }>;
export const defaultLimit = 100;
export const defaultMaxPages = 50;

/**
 * Relay returns the NEWEST `limit` messages after a cursor, so a full page may hide older unseen ones.
 * A full page is therefore followed by a page strictly below its oldest message (still above the cursor)
 * until a short page proves the gap closed. `complete: false` means the page budget ran out first.
 */
export async function collectSince<M extends Message>(list: ListPage<M>, cursor: Cursor | null, limit = defaultLimit, maxPages = defaultMaxPages): Promise<Collected<M>> {
  const walk = async (before: string | undefined, collected: readonly M[], pages: number): Promise<Collected<M>> => {
    const page = await list({ limit, ...(cursor ? { after: cursor.messageId } : {}), ...(before ? { before } : {}) });
    const messages = [...collected, ...page];
    const oldest = page.toSorted(compareMessages)[0];
    if (page.length < limit || !oldest) return { messages, complete: true };
    return pages + 1 >= maxPages ? { messages, complete: false } : walk(oldest.messageId, messages, pages + 1);
  };
  return walk(undefined, [], 0);
}

export type Poll<D> = Readonly<{ items: readonly D[]; cursor: Cursor | null; complete: boolean }>;

/**
 * One bounded read: new items in message order and the cursor to persist with them.
 * An incomplete read hands back what it found but keeps the old cursor, so no older message is ever skipped.
 */
export async function pollSince<M extends Message, D>(list: ListPage<M>, cursor: Cursor | null, extract: (message: M) => D | undefined, limit = defaultLimit, maxPages = defaultMaxPages): Promise<Poll<D>> {
  const collected = await collectSince(list, cursor, limit, maxPages);
  const step = advance(cursor, collected.messages);
  return {
    items: step.fresh.flatMap(message => { const item = extract(message); return item === undefined ? [] : [item]; }),
    cursor: collected.complete ? step.cursor : cursor,
    complete: collected.complete,
  };
}
