import type { BoardMessage } from '../../board.js';
import type { Disruption } from '../../shared.js';

/** What the server has already heard on the Relay stream (or authored itself) and handed to an actor, so the actor need not read Relay. */
export type Inbox = Readonly<{ board: readonly BoardMessage[]; disruptions: readonly Disruption[] }>;
export const emptyInbox: Inbox = { board: [], disruptions: [] };
export const inboxCapacity = 500;

const distinct = <A extends Readonly<{ id: string }>>(items: readonly A[]): readonly A[] => [...new Map(items.map(item => [item.id, item] as const)).values()];

/** Distinct by id, arrival order kept, the newest `inboxCapacity` of each kind. Redelivery (the Relay copy of an echoed message) is a no-op. */
export const mergeInbox = (current: Inbox | undefined, incoming: Inbox): Inbox => ({
  board: distinct([...(current?.board ?? []), ...incoming.board]).slice(-inboxCapacity),
  disruptions: distinct([...(current?.disruptions ?? []), ...incoming.disruptions]).slice(-inboxCapacity),
});

/** What remains after `consumed` was processed; anything delivered while the actor was busy survives. */
export const drainInbox = (current: Inbox | undefined, consumed: Inbox): Inbox => {
  const board = new Set(consumed.board.map(message => message.id));
  const disruptions = new Set(consumed.disruptions.map(item => item.id));
  return { board: (current?.board ?? []).filter(message => !board.has(message.id)), disruptions: (current?.disruptions ?? []).filter(item => !disruptions.has(item.id)) };
};
