import type { BoardMessage } from '../../board.js';
import type { RelayOutcome } from '../../shared.js';

/** Distinct by id, first position kept: a decision made twice is one message. */
export const enqueue = (queue: readonly BoardMessage[], incoming: readonly BoardMessage[]): readonly BoardMessage[] =>
  [...new Map([...queue, ...incoming].map(message => [message.id, message] as const)).values()];

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Posts in order, stops at the first failure and keeps that message and everything after it. Never throws.
 * Posting is idempotent on the message id, so an ambiguous failure that actually landed is harmless to retry.
 */
export async function flush(
  post: (message: BoardMessage) => Promise<RelayOutcome<string>>, queue: readonly BoardMessage[],
): Promise<Readonly<{ remaining: readonly BoardMessage[]; failure: string | null }>> {
  const sent = new Set<string>();
  const failure = await queue.reduce<Promise<string | null>>(async (previous, message) => {
    if (await previous !== null) return previous;
    const result = await post(message).catch((error: unknown): RelayOutcome<string> => ({ status: 'unavailable', message: describe(error) }));
    if (result.status === 'ok') sent.add(message.id);
    return result.status === 'ok' ? null : result.message;
  }, Promise.resolve(null));
  return { remaining: queue.filter(message => !sent.has(message.id)), failure };
}
