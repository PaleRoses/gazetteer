import type { BoardMessage } from '../../core/board.js';
import type { RelayOutcome } from '../../core/types.js';

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

/** What an actor hands the server to write to Relay on its behalf: its identity and everything not yet acknowledged. */
/** `relay` is null until the actor has joined the channel: nothing is written then, and everything waits in its outbox. */
export type Outgoing<D> = Readonly<{ relay: Readonly<{ token: string; channel: string }> | null; board: readonly BoardMessage[]; disruptions: readonly D[] }>;

/** What remains after `sent` ids were acknowledged by Relay. */
export const without = <A extends Readonly<{ id: string }>>(queue: readonly A[], sent: readonly string[]): readonly A[] => queue.filter(item => !sent.includes(item.id));

export type Transmitted = Readonly<{ board: readonly string[]; disruptions: readonly string[]; failure: string | null }>;

/**
 * Writes an actor's outgoing queue to Relay in order, disruptions before board posts, stopping at the first failure.
 * One implementation for the server's background writer and the actor's alarm.
 */
export async function transmit<D extends Readonly<{ id: string }>>(
  outgoing: Outgoing<D>,
  effects: Readonly<{ post(message: BoardMessage): Promise<RelayOutcome<string>>; publish(disruption: D): Promise<RelayOutcome<unknown>> }>,
): Promise<Transmitted> {
  const sent: string[] = [];
  const failure = await outgoing.disruptions.reduce<Promise<string | null>>(async (previous, disruption) => {
    if (await previous !== null) return previous;
    const result = await effects.publish(disruption).catch((error: unknown): RelayOutcome<unknown> => ({ status: 'unavailable', message: describe(error) }));
    if (result.status === 'ok') sent.push(disruption.id);
    return result.status === 'ok' ? null : result.message;
  }, Promise.resolve(null));
  if (failure !== null) return { board: [], disruptions: sent, failure };
  const posted = await flush(effects.post, outgoing.board);
  return { board: outgoing.board.filter(message => !posted.remaining.some(rest => rest.id === message.id)).map(message => message.id), disruptions: sent, failure: posted.failure };
}
