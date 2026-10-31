import { portById, type PortId } from '../../../core/ports';
import { bookingKey, type Offer, type RecoveryMessage } from '../../../core/recovery';
import { plugOf, type TerminalRequest } from '../../../core/services';
import type { Bookings } from '../../booking/ledger';

type Message<K extends RecoveryMessage['kind']> = Extract<RecoveryMessage, { kind: K }>;
type TerminalOffer = Extract<Offer, { service: 'unload' | 'storage' }>;

/** Every number the desk decides itself. The prices, windows and plugs are the world's (core/services.ts terminalQuote). */
export const terminal = {
  /** An unload window occupies its crane slot for the hour from its start: the same hour the cargo agent books. */
  unloadMinutes: 60,
  /** Request ids remembered so a replayed board is answered once: the board's own history window is a few hundred messages (inbox capacity 500). */
  seenCapacity: 500,
} as const;

/** One offer made to one case, with the physical resource it would occupy and what the ledger has made of it. */
export type OfferRecord = Readonly<{
  caseId: string; offer: TerminalOffer; messageId: string; resource: string; start: string; end: string;
  status: 'open' | 'held' | 'confirmed' | 'released' | 'withdrawn';
}>;
export type TerminalMemory = Readonly<{ offers: Readonly<Record<string, OfferRecord>>; seen: readonly string[] }>;
export const emptyTerminalMemory: TerminalMemory = { offers: {}, seen: [] };

export type TerminalContext = Readonly<{
  city: PortId; workspaceId: string; now: string;
  /** The world's price and window for an ask, or null when the desk has nothing: passed in, so the desk's decisions hold no capacity data. */
  quote: (ask: TerminalRequest) => Offer | null;
  ledger: Pick<Bookings, 'hold' | 'confirm' | 'release' | 'find' | 'free'>;
}>;
export type Decision = Readonly<{ memory: TerminalMemory; posts: readonly RecoveryMessage[] }>;

const ms = Date.parse;
const plus = (at: string, minutes: number): string => new Date(ms(at) + minutes * 60_000).toISOString();
const clock = (at: string): string => `${at.slice(11, 16)}Z`;
const author = (city: PortId) => ({ role: 'city', city, element: 'terminal' }) as const;
const name = (city: PortId): string => portById.get(city)?.name ?? city;
const live = (record: OfferRecord): boolean => record.status === 'held' || record.status === 'confirmed';

/**
 * The physical thing an offer occupies. A crane window is its own offer id; a storage offer names its interval, so its resource is the world's plug
 * (plugOf): two cases' overlapping intervals on one plug clash in the ledger.
 */
const resourceOf = (offer: TerminalOffer): Readonly<{ resource: string; start: string; end: string }> =>
  offer.service === 'unload' ? { resource: offer.id, start: offer.at, end: plus(offer.at, terminal.unloadMinutes) }
    : { resource: plugOf(offer.id) ?? offer.id, start: offer.from, end: offer.until };

/** What the case already holds on a resource: those hours are its own, so extending a booking only needs the hours it does not cover yet. */
const ownOn = (memory: TerminalMemory, caseId: string, resource: string): readonly OfferRecord[] =>
  Object.values(memory.offers).filter(record => record.caseId === caseId && record.resource === resource && live(record));

const uncovered = (start: string, end: string, own: readonly OfferRecord[]): readonly (readonly [string, string])[] =>
  own.reduce<readonly (readonly [string, string])[]>((gaps, held) => gaps.flatMap(([from, until]): (readonly [string, string])[] => [
    ...(ms(from) < ms(held.start) ? [[from, ms(until) < ms(held.start) ? until : held.start] as const] : []),
    ...(ms(until) > ms(held.end) ? [[ms(from) > ms(held.end) ? from : held.end, until] as const] : []),
  ]), [[start, end]]);

/** Never offer what is held or confirmed for someone else: every hour the case does not already hold must be free in the ledger. */
const available = (context: TerminalContext, memory: TerminalMemory, caseId: string, offer: TerminalOffer): boolean => {
  const { resource, start, end } = resourceOf(offer);
  return uncovered(start, end, ownOn(memory, caseId, resource)).every(([from, until]) => context.ledger.free(resource, from, until));
};

/** The first quote that is free: a taken crane window moves the ask past it; a taken plug has no alternative here. */
const quoteFree = (context: TerminalContext, memory: TerminalMemory, caseId: string, ask: TerminalRequest): TerminalOffer | null => {
  const quoted = context.quote(ask);
  if (!quoted || quoted.service === 'truck') return null;
  if (available(context, memory, caseId, quoted)) return quoted;
  return quoted.service === 'unload' ? quoteFree(context, memory, caseId, { ...ask, after: plus(quoted.at, 1) }) : null;
};

const summaryOf = (city: PortId, offer: TerminalOffer): string => offer.service === 'unload'
  ? `${name(city)} terminal desk: unload at ${clock(offer.at)} for EUR ${offer.priceEur}, good until ${clock(offer.expiresAt)}.`
  : `${name(city)} terminal desk: powered plug ${(plugOf(offer.id) ?? offer.id).split(':').slice(2).join(':')} from ${clock(offer.from)} to ${clock(offer.until)} for EUR ${offer.priceEur}, good until ${clock(offer.expiresAt)}.`;

const answer = (context: TerminalContext, memory: TerminalMemory, request: Message<'recovery.request'>): Decision => {
  if (request.service === 'truck') return { memory, posts: [] };
  const offer = quoteFree(context, memory, request.caseId, { service: request.service, ...(request.after ? { after: request.after } : {}), ...(request.until ? { until: request.until } : {}) });
  if (!offer || (offer.service === 'storage' && request.powered === true && !offer.powered)) return { memory, posts: [] };
  const message: Message<'recovery.offer'> = {
    id: `offer:${request.caseId}:${offer.id}`, kind: 'recovery.offer', author: author(context.city), at: context.now, caseId: request.caseId,
    answers: [request.id], offer, summary: summaryOf(context.city, offer).slice(0, 280),
  };
  const record: OfferRecord = { caseId: request.caseId, offer, messageId: message.id, ...resourceOf(offer), status: 'open' };
  return { memory: { ...memory, offers: { ...memory.offers, [bookingKey(request.caseId, offer.id)]: record } }, posts: [message] };
};

const set = (memory: TerminalMemory, record: OfferRecord, status: OfferRecord['status']): TerminalMemory =>
  ({ ...memory, offers: { ...memory.offers, [bookingKey(record.caseId, record.offer.id)]: { ...record, status } } });

const withdraw = (context: TerminalContext, memory: TerminalMemory, record: OfferRecord, reason: string): Decision => ({
  memory: set(memory, record, 'withdrawn'),
  posts: [{
    id: `withdraw:${record.caseId}:${record.offer.id}`, kind: 'recovery.withdraw', author: author(context.city), at: context.now, caseId: record.caseId,
    answers: [record.messageId], offerId: record.offer.id, reason, summary: `${name(context.city)} terminal desk withdraws ${record.offer.id}: ${reason}`.slice(0, 280),
  }],
});

/**
 * A hold the desk records in the ledger under the case's key. A storage extension supersedes the case's shorter booking on the same plug: its
 * new hours were checked free, so the shorter booking is released and the whole interval held. A key the ledger already has is adopted.
 */
const holdOn = (context: TerminalContext, memory: TerminalMemory, message: Message<'recovery.hold'>): Decision => {
  const record = memory.offers[bookingKey(message.caseId, message.offerId)];
  if (!record || record.status !== 'open') return { memory, posts: [] };
  const recorded = context.ledger.find(message.key);
  if (recorded) return { memory: set(memory, record, recorded.status === 'confirmed' ? 'confirmed' : recorded.status === 'held' ? 'held' : record.status), posts: [] };
  if (ms(record.offer.expiresAt) <= ms(context.now)) return withdraw(context, memory, record, 'the offer had expired before it was held');
  if (!available(context, memory, record.caseId, record.offer)) return withdraw(context, memory, record, 'the capacity is already held for another case');
  const superseded = ownOn(memory, record.caseId, record.resource).filter(other => other.offer.id !== record.offer.id);
  superseded.forEach(other => { const booking = context.ledger.find(bookingKey(other.caseId, other.offer.id)); if (booking) context.ledger.release(booking.id); });
  const released = superseded.reduce((current, other) => set(current, other, 'released'), memory);
  const held = context.ledger.hold({
    key: message.key, workspaceId: context.workspaceId, caseId: record.caseId, resource: record.resource, start: record.start, end: record.end,
    priceEur: record.offer.priceEur, expiresAt: message.expiresAt,
    heldBy: message.author.role === 'cargo' ? `cargo:${message.author.id}` : `terminal:${context.city}`,
  });
  return held.ok ? { memory: set(released, record, 'held'), posts: [] } : withdraw(context, released, record, 'the hold could not be recorded');
};

const confirmOn = (context: TerminalContext, memory: TerminalMemory, message: Message<'recovery.confirm'>): Decision => {
  const record = memory.offers[bookingKey(message.caseId, message.offerId)];
  const booking = record ? context.ledger.find(message.key) : undefined;
  if (!record || !booking || record.status === 'withdrawn') return { memory, posts: [] };
  const confirmed = context.ledger.confirm(booking.id);
  return confirmed.ok ? { memory: set(memory, record, 'confirmed'), posts: [] } : withdraw(context, memory, record, 'the hold expired before it was confirmed');
};

const releaseOn = (context: TerminalContext, memory: TerminalMemory, message: Message<'recovery.release'>): Decision => {
  const record = memory.offers[bookingKey(message.caseId, message.offerId)];
  const booking = record ? context.ledger.find(message.key) : undefined;
  if (booking) context.ledger.release(booking.id);
  return record ? { memory: set(memory, record, 'released'), posts: [] } : { memory, posts: [] };
};

const heardBy = (city: PortId) => (message: RecoveryMessage): boolean => !(message.author.role === 'city' && message.author.city === city);

const react = (context: TerminalContext, memory: TerminalMemory, message: RecoveryMessage): Decision => {
  switch (message.kind) {
    case 'recovery.request': return message.to.role === 'city' && message.to.city === context.city ? answer(context, memory, message) : { memory, posts: [] };
    case 'recovery.hold': return holdOn(context, memory, message);
    case 'recovery.confirm': return confirmOn(context, memory, message);
    case 'recovery.release': return releaseOn(context, memory, message);
    case 'recovery.offer': case 'recovery.withdraw': case 'recovery.plan': return { memory, posts: [] };
  }
};

/**
 * What the terminal desk does with what it heard: answers each unload or storage request once with the first free window the world quotes,
 * extends storage when asked for longer, and keeps the ledger in step with the holds, confirms and releases on its offers.
 */
export function hear(context: TerminalContext, memory: TerminalMemory, heard: readonly RecoveryMessage[]): Decision {
  const fresh = heard.filter(heardBy(context.city)).filter(message => !memory.seen.includes(message.id))
    .sort((a, b) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id));
  return fresh.reduce<Decision>((carried, message) => {
    const next = react(context, carried.memory, message);
    return { memory: { ...next.memory, seen: [...next.memory.seen, message.id].slice(-terminal.seenCapacity) }, posts: [...carried.posts, ...next.posts] };
  }, { memory, posts: [] });
}
