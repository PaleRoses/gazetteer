import type { RelayMessage } from '@agent-relay/sdk';

export type Message = Pick<RelayMessage, 'messageId' | 'createdAt' | 'metadata'>;
/** A relevant message found during a descent, held (with its extracted item) until the whole gap is read. */
export type Pending = Readonly<{ messageId: string; createdAt: string | null; item: unknown }>;
/** An unfinished walk down a gap larger than one read's budget: resume below `frontier`, release once the cursor is reached. */
export type Descent = Readonly<{ top: Readonly<{ messageId: string; createdAt: string | null }>; frontier: string; pending: readonly Pending[] }>;
/** `messageId: null` means nothing confirmed yet (a first read that is still descending). */
export type Cursor = Readonly<{ messageId: string | null; createdAt: string | null; descent?: Descent }>;
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

type Top = Readonly<{ messageId: string; createdAt: string | null }>;
const cursorOf = (message: Key): Top => ({ messageId: message.messageId, createdAt: message.createdAt ?? null });
const confirmed = (cursor: Cursor | null): Key | null => (cursor && cursor.messageId !== null ? { messageId: cursor.messageId, createdAt: cursor.createdAt } : null);
const distinct = <M extends Message>(messages: readonly M[]): readonly M[] => [...new Map(messages.map(message => [message.messageId, message])).values()];

export type Advance<M extends Message> = Readonly<{ fresh: readonly M[]; cursor: Cursor | null }>;

/**
 * Pure step: the messages of any page (any order, overlapping, replayed) that lie strictly past the cursor,
 * oldest first, and the cursor moved to the newest of them. Applying the same page twice yields nothing new.
 */
export const advance = <M extends Message>(cursor: Cursor | null, page: readonly M[]): Advance<M> => {
  const floor = confirmed(cursor);
  const fresh = distinct(page).filter(message => floor === null || compareMessages(message, floor) > 0).toSorted(compareMessages);
  const newest = fresh.at(-1);
  return { fresh, cursor: newest ? cursorOf(newest) : cursor };
};

export const defaultLimit = 100;
export const defaultMaxPages = 50;

export type Poll<D> = Readonly<{ items: readonly D[]; cursor: Cursor | null; complete: boolean }>;

/**
 * One bounded read (at most `maxPages` requests): new items in message order and the cursor to persist with them.
 *
 * Relay returns the NEWEST `limit` messages after a cursor, so a full page may hide older unseen ones: the read
 * descends, each next page strictly below the previous one's oldest message and still above the cursor, until a short
 * page closes the gap. A gap larger than the budget is not abandoned: the returned cursor keeps its confirmed position
 * and carries the descent (frontier, newest message seen, the relevant items found so far). The next read resumes
 * below the frontier, so every read makes progress and the walk converges in ceil(gap / (limit * maxPages)) reads.
 * Nothing is released until the cursor is reached, so items always come out oldest first, once.
 * `revive` re-validates items that were persisted in a descent.
 */
export async function pollSince<M extends Message, D>(
  list: ListPage<M>, cursor: Cursor | null, extract: (message: M) => D | undefined,
  limit = defaultLimit, maxPages = defaultMaxPages, revive: (value: unknown) => D | undefined = value => value as D,
): Promise<Poll<D>> {
  const floor = confirmed(cursor);
  const resumed = cursor?.descent;
  const walk = async (before: string | undefined, top: Top | null, held: readonly Pending[], pages: number): Promise<Poll<D>> => {
    const page = await list({ limit, ...(floor ? { after: floor.messageId } : {}), ...(before ? { before } : {}) });
    const newest = page.toSorted(compareMessages).at(-1);
    const oldest = page.toSorted(compareMessages)[0];
    const peak = top ?? (newest ? cursorOf(newest) : null);
    const pending = [...new Map([...held, ...page.flatMap(message => {
      const item = extract(message);
      return item === undefined ? [] : [{ messageId: message.messageId, createdAt: message.createdAt ?? null, item } satisfies Pending];
    })].map(entry => [entry.messageId, entry])).values()];
    if (page.length < limit || !oldest) {
      const released = pending.toSorted(compareMessages).flatMap(entry => revive(entry.item) ?? []);
      return { items: released, cursor: peak ?? cursor, complete: true };
    }
    if (pages + 1 >= maxPages) {
      const descent: Descent = { top: peak ?? cursorOf(oldest), frontier: oldest.messageId, pending };
      return { items: [], cursor: { messageId: floor?.messageId ?? null, createdAt: floor?.createdAt ?? null, descent }, complete: false };
    }
    return walk(oldest.messageId, peak, pending, pages + 1);
  };
  return walk(resumed?.frontier, resumed?.top ?? null, resumed?.pending ?? [], 0);
}
