import type { PortId } from '../../../core/ports';
import { bookingKey, type Offer, type RecoveryMessage } from '../../../core/recovery';
import type { Bookings } from '../../booking/ledger';
import { haulier } from './constants';
import type { Truck } from './truck';

type TruckOffer = Extract<Offer, { service: 'truck' }>;
type Message<K extends RecoveryMessage['kind']> = Extract<RecoveryMessage, { kind: K }>;

/** One offer made to one case. Keyed by the case's booking key, so a truck offered to two cases is two records. */
export type OfferRecord = Readonly<{ caseId: string; truck: Truck; offer: TruckOffer; messageId: string; status: 'open' | 'withdrawn' }>;
export type HaulierMemory = Readonly<{ offers: Readonly<Record<string, OfferRecord>>; seen: readonly string[] }>;
export const emptyHaulierMemory: HaulierMemory = { offers: {}, seen: [] };

export type HaulierContext = Readonly<{
  city: PortId; workspaceId: string; trucks: readonly Truck[]; now: string;
  /** The owner of the physical resource writes the ledger: the haulier records the holds, confirms and releases it hears for its trucks. The cargo agent only reads, through find(key). */
  ledger: Pick<Bookings, 'hold' | 'confirm' | 'release' | 'find' | 'free'>;
}>;
export type Decision = Readonly<{ memory: HaulierMemory; posts: readonly RecoveryMessage[] }>;

const ms = Date.parse;
const plus = (at: string, minutes: number): string => new Date(ms(at) + minutes * 60_000).toISOString();
const clock = (at: string): string => `${at.slice(11, 16)}Z`;
const author = (city: PortId) => ({ role: 'haulier', city }) as const;
/** The offer id is the truck's, shared by every case it is offered to, and doubles as the ledger resource the cargo agent books: two cases cannot hold one truck. */
export const truckOfferId = (city: PortId, truckId: string): string => `${city}:truck:${truckId}`;
const heardBy = (city: PortId) => (message: RecoveryMessage): boolean => message.author.role !== 'haulier' || message.author.city !== city;

/** The earliest truck leaving no earlier than the request allows, not already offered to this case and not held in the ledger. */
const choose = (context: HaulierContext, memory: HaulierMemory, request: Message<'recovery.request'>): Truck | undefined => {
  const earliest = Math.max(ms(context.now), request.after ? ms(request.after) : -Infinity);
  return [...context.trucks].sort((a, b) => ms(a.departs) - ms(b.departs) || a.id.localeCompare(b.id)).find(truck => {
    const offerId = truckOfferId(context.city, truck.id);
    return ms(truck.departs) >= earliest && !memory.offers[bookingKey(request.caseId, offerId)] && context.ledger.free(offerId, truck.departs, plus(truck.departs, haulier.slotMinutes));
  });
};

const answer = (context: HaulierContext, memory: HaulierMemory, request: Message<'recovery.request'>): Decision => {
  const truck = choose(context, memory, request);
  if (!truck) return { memory, posts: [] };
  const offer: TruckOffer = { service: 'truck', id: truckOfferId(context.city, truck.id), provider: author(context.city), departs: truck.departs, priceEur: truck.priceEur, expiresAt: plus(context.now, haulier.offerTtlMinutes) };
  const message: Message<'recovery.offer'> = {
    id: `offer:${request.caseId}:${offer.id}`, kind: 'recovery.offer', author: author(context.city), at: context.now, caseId: request.caseId, answers: [request.id], offer,
    summary: `Truck ${truck.id} leaves ${context.city} at ${clock(truck.departs)} for EUR ${truck.priceEur}; this offer holds for ${haulier.offerTtlMinutes} minutes.`,
  };
  return { memory: { ...memory, offers: { ...memory.offers, [bookingKey(request.caseId, offer.id)]: { caseId: request.caseId, truck, offer, messageId: message.id, status: 'open' } } }, posts: [message] };
};

const withdrawal = (context: HaulierContext, record: OfferRecord, reason: string): Message<'recovery.withdraw'> => ({
  id: `withdraw:${record.caseId}:${record.offer.id}`, kind: 'recovery.withdraw', author: author(context.city), at: context.now, caseId: record.caseId, answers: [record.messageId],
  offerId: record.offer.id, reason, summary: `Truck ${record.truck.id} (${clock(record.truck.departs)}) is withdrawn: ${reason}`.slice(0, 280),
});

const withdrawOne = (context: HaulierContext, memory: HaulierMemory, record: OfferRecord, reason: string): Decision => ({
  memory: { ...memory, offers: { ...memory.offers, [bookingKey(record.caseId, record.offer.id)]: { ...record, status: 'withdrawn' } } },
  posts: [withdrawal(context, record, reason)],
});

/** The offer this message acts on, if it is one of ours and still open. */
const openOffer = (memory: HaulierMemory, message: Readonly<{ caseId: string; offerId: string }>): OfferRecord | undefined => {
  const record = memory.offers[bookingKey(message.caseId, message.offerId)];
  return record?.status === 'open' ? record : undefined;
};

/** A hold is recorded under the cargo agent's key, with the truck's offer id as the resource. A truck held for another case, or an offer past its time, is withdrawn from this one. */
const holdOn = (context: HaulierContext, memory: HaulierMemory, message: Message<'recovery.hold'>): Decision => {
  const record = openOffer(memory, message);
  if (!record) return { memory, posts: [] };
  if (ms(record.offer.expiresAt) <= ms(context.now)) return withdrawOne(context, memory, record, 'the offer had expired before it was held');
  const held = context.ledger.hold({
    key: message.key, workspaceId: context.workspaceId, caseId: message.caseId, resource: record.offer.id, start: record.truck.departs,
    end: plus(record.truck.departs, haulier.slotMinutes), priceEur: record.truck.priceEur, expiresAt: message.expiresAt,
    heldBy: message.author.role === 'cargo' ? `cargo:${message.author.id}` : `haulier:${context.city}`,
  });
  return !held.ok && held.error === 'resource_taken' ? withdrawOne(context, memory, record, 'the truck is already held for another case') : { memory, posts: [] };
};

const confirmOn = (context: HaulierContext, memory: HaulierMemory, message: Message<'recovery.confirm'>): Decision => {
  const record = openOffer(memory, message);
  const booking = record ? context.ledger.find(message.key) : undefined;
  if (!record || !booking) return { memory, posts: [] };
  const confirmed = context.ledger.confirm(booking.id);
  return !confirmed.ok && confirmed.error === 'expired' ? withdrawOne(context, memory, record, 'the hold expired before it was confirmed') : { memory, posts: [] };
};

const releaseOn = (context: HaulierContext, memory: HaulierMemory, message: Message<'recovery.release'>): Decision => {
  const booking = memory.offers[bookingKey(message.caseId, message.offerId)] ? context.ledger.find(message.key) : undefined;
  if (booking) context.ledger.release(booking.id);
  return { memory, posts: [] };
};

const react = (context: HaulierContext, memory: HaulierMemory, message: RecoveryMessage): Decision => {
  switch (message.kind) {
    case 'recovery.request': return message.to.role === 'haulier' && message.to.city === context.city && message.service === 'truck' ? answer(context, memory, message) : { memory, posts: [] };
    case 'recovery.hold': return holdOn(context, memory, message);
    case 'recovery.confirm': return confirmOn(context, memory, message);
    case 'recovery.release': return releaseOn(context, memory, message);
    case 'recovery.offer': case 'recovery.withdraw': case 'recovery.plan': return { memory, posts: [] };
  }
};

/** What the haulier does with what it heard on the board: answers each request for a truck, once, with its earliest free truck, and keeps the ledger in step with the holds, confirms and releases for its offers. */
export function hear(context: HaulierContext, memory: HaulierMemory, heard: readonly RecoveryMessage[]): Decision {
  const fresh = heard.filter(heardBy(context.city)).filter(message => !memory.seen.includes(message.id))
    .sort((a, b) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id));
  return fresh.reduce<Decision>((carried, message) => {
    const next = react(context, carried.memory, message);
    return { memory: { ...next.memory, seen: [...next.memory.seen, message.id].slice(-haulier.seenCapacity) }, posts: [...carried.posts, ...next.posts] };
  }, { memory, posts: [] });
}

/**
 * The demo's control: the haulier withdraws a truck it has offered, the named offer or else the open one that leaves last, from every case it was
 * offered to. Whatever the ledger holds or has confirmed for it is released, so the capacity is genuinely gone from those cases.
 */
export function withdrawTruck(context: HaulierContext, memory: HaulierMemory, reason: string, offerId?: string): Decision & Readonly<{ withdrawn: string | null }> {
  const open = Object.values(memory.offers).filter(record => record.status === 'open');
  const last = [...open].sort((a, b) => ms(b.truck.departs) - ms(a.truck.departs))[0];
  const target = offerId ?? last?.offer.id;
  const affected = open.filter(record => record.offer.id === target);
  if (affected.length === 0 || target === undefined) return { memory, posts: [], withdrawn: null };
  affected.forEach(record => { const booking = context.ledger.find(bookingKey(record.caseId, record.offer.id)); if (booking) context.ledger.release(booking.id); });
  const closed = Object.fromEntries(affected.map(record => [bookingKey(record.caseId, record.offer.id), { ...record, status: 'withdrawn' as const }]));
  return { memory: { ...memory, offers: { ...memory.offers, ...closed } }, posts: affected.map(record => withdrawal(context, record, reason)), withdrawn: target };
}
