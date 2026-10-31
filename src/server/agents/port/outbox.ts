import type { Disruption } from '../../../shared';

/**
 * A port's disruption queue. `pending` holds what arrived before the actor was registered with Relay: it needs no Relay to exist,
 * so a simulated disruption is durable from the moment the actor accepts it. `outbox` is what is registered and waiting to be
 * published; `published` is what Relay has acknowledged. An id lives in exactly one of the three.
 */
export type Queue = Readonly<{ pending: readonly Disruption[]; outbox: readonly Disruption[]; published: readonly string[] }>;

export const emptyQueue: Queue = { pending: [], outbox: [], published: [] };

const seen = (queue: Queue, id: string): boolean =>
  queue.pending.some(item => item.id === id) || queue.outbox.some(item => item.id === id) || queue.published.includes(id);

/** Accepts a disruption once: a repeat of any id already held or published changes nothing. */
export const accept = (queue: Queue, disruption: Disruption, registered: boolean): Queue =>
  seen(queue, disruption.id) ? queue
    : registered ? { ...queue, outbox: [...queue.outbox, disruption] }
      : { ...queue, pending: [...queue.pending, disruption] };

/** Moves what waited for registration into the outbox, in arrival order. */
export const adopt = (queue: Queue): Queue => ({
  ...queue, pending: [],
  outbox: [...queue.outbox, ...queue.pending.filter(item => !queue.outbox.some(held => held.id === item.id) && !queue.published.includes(item.id))],
});

/** What was published leaves the outbox and is remembered, so it is never queued again. */
export const delivered = (queue: Queue, sent: readonly Disruption[]): Queue => ({
  ...queue,
  outbox: queue.outbox.filter(item => !sent.some(done => done.id === item.id)),
  published: [...queue.published, ...sent.map(item => item.id).filter(id => !queue.published.includes(id))],
});

export const waiting = (queue: Queue): number => queue.pending.length + queue.outbox.length;
