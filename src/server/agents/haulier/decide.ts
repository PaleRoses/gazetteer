import type { PortId } from '../../../core/ports';
import { bookingKey, type Offer, type RecoveryMessage } from '../../../core/recovery';
import type { Bookings } from '../../booking/ledger';
import { haulier } from './constants';
import type { Truck } from './truck';

type TruckOffer = Extract<Offer, { service: 'truck' }>;
type Message<K extends RecoveryMessage['kind']> = Extract<RecoveryMessage, { kind: K }>;

export type OfferRecord = Readonly<{ caseId: string; truck: Truck; offer: TruckOffer; messageId: string; status: 'open' | 'withdrawn' }>;
export type HaulierMemory = Readonly<{ offers: Readonly<Record<string, OfferRecord>>; seen: readonly string[] }>;
export const emptyHaulierMemory: HaulierMemory = { offers: {}, seen: [] };

export type HaulierContext = Readonly<{
  city: PortId; workspaceId: string; trucks: readonly Truck[]; now: string;
  ledger: Pick<Bookings, 'hold' | 'confirm' | 'release' | 'find' | 'free'>;
}>;
export type Decision = Readonly<{ memory: HaulierMemory; posts: readonly RecoveryMessage[] }>;

const ms = Date.parse;
const plus = (at: string, minutes: number): string => new Date(ms(at) + minutes * 60_000).toISOString();
const clock = (at: string): string => `${at.slice(11, 16)}Z`;
const author = (city: PortId) => ({ role: 'haulier', city }) as const;
export const truckResource = (city: PortId, truckId: string): string => `${city}:truck:${truckId}`;
const offerIdFor = (truck: Truck, caseId: string): string => `truck:${truck.id}:${caseId}`;
const heardBy = (city: PortId) => (message: RecoveryMessage): boolean => message.author.role !== 'haulier' || message.author.city !== city;

const withdrawal = (context: HaulierContext, record: OfferRecord, reason: string): Message<'recovery.withdraw'> => ({
  id: `withdraw:${record.offer.id}`, kind: 'recovery.withdraw', author: author(context.city), at: context.now, caseId: record.caseId, answers: [record.messageId],
  offerId: record.offer.id, reason,
  summary: `Truck ${record.truck.id} (${clock(record.truck.departs)}) is withdrawn: ${reason}`.slice(0, 280),
});

const withdraw = (context: HaulierContext, memory: HaulierMemory, record: OfferRecord, reason: string): Decision => ({
  memory: { ...memory, offers: { ...memory.offers, [record.offer.id]: { ...record, status: 'withdrawn' } } },
  posts: [withdrawal(context, record, reason)],
});

/** The earliest truck leaving no earlier than the request allows, whose slot is free in the ledger. */
const choose = (context: HaulierContext, memory: HaulierMemory, request: Message<'recovery.request'>): Truck | undefined => {
  const earliest = Math.max(ms(context.now), request.after ? ms(request.after) : -Infinity);
  return [...context.trucks].sort((a, b) => ms(a.departs) - ms(b.departs) || a.id.localeCompare(b.id))
    .find(truck => ms(truck.departs) >= earliest && !(memory.offers[offerIdFor(truck, request.caseId)]) && context.ledger.free(truckResource(context.city, truck.id), truck.departs, plus(truck.departs, haulier.slotMinutes)));
};

const answer = (context: HaulierContext, memory: HaulierMemory, request: Message<'recovery.request'>): Decision => {
  const truck = choose(context, memory, request);
  if (!truck) return { memory, posts: [] };
  const offer: TruckOffer = { service: 'truck', id: offerIdFor(truck, request.caseId), provider: author(context.city), departs: truck.departs, priceEur: truck.priceEur, expiresAt: plus(context.now, haulier.offerTtlMinutes) };
  const message: Message<'recovery.offer'> = {
    id: `offer:${offer.id}`, kind: 'recovery.offer', author: author(context.city), at: context.now, caseId: request.caseId, answers: [request.id], offer,
    summary: `Truck ${truck.id} leaves ${context.city} at ${clock(truck.departs)} for EUR ${truck.priceEur}; this offer holds for ${haulier.offerTtlMinutes} minutes.`,
  };
  return { memory: { ...memory, offers: { ...memory.offers, [offer.id]: { caseId: request.caseId, truck, offer, messageId: message.id, status: 'open' } } }, posts: [message] };
};

const holdOn = (context: HaulierContext, memory: HaulierMemory, message: Message<'recovery.hold'>): Decision => {
  const record = memory.offers[message.offerId];
  if (!record || record.status !== 'open') return { memory, posts: [] };
  if (ms(record.offer.expiresAt) <= ms(context.now)) return withdraw(context, memory, record, 'the offer had expired before it was held');
  const held = context.ledger.hold({
    key: message.key, workspaceId: context.workspaceId, caseId: message.caseId, resource: truckResource(context.city, record.truck.id),
    start: record.truck.departs, end: plus(record.truck.departs, haulier.slotMinutes), priceEur: record.truck.priceEur, expiresAt: message.expiresAt, heldBy: `haulier:${context.city}`,
  });
  return held.ok ? { memory, posts: [] } : withdraw(context, memory, record, held.error === 'resource_taken' ? 'the truck is already held for another case' : 'the hold could not be recorded');
};

const confirmOn = (context: HaulierContext, memory: HaulierMemory, message: Message<'recovery.confirm'>): Decision => {
  const record = memory.offers[message.offerId];
  const booking = record ? context.ledger.find(message.key) : undefined;
  if (!record || record.status !== 'open' || !booking) return { memory, posts: [] };
  const confirmed = context.ledger.confirm(booking.id);
  return confirmed.ok ? { memory, posts: [] } : withdraw(context, memory, record, 'the hold expired before it was confirmed');
};

const releaseOn = (context: HaulierContext, memory: HaulierMemory, message: Message<'recovery.release'>): Decision => {
  const booking = memory.offers[message.offerId] ? context.ledger.find(message.key) : undefined;
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

/** What the haulier does with what it heard on the board: answers requests with its earliest free truck, keeps the ledger in step with holds, confirms and releases. Each message is handled once. */
export function hear(context: HaulierContext, memory: HaulierMemory, heard: readonly RecoveryMessage[]): Decision {
  const fresh = heard.filter(heardBy(context.city)).filter(message => !memory.seen.includes(message.id))
    .sort((a, b) => ms(a.at) - ms(b.at) || a.id.localeCompare(b.id));
  return fresh.reduce<Decision>((carried, message) => {
    const next = react(context, carried.memory, message);
    return { memory: { ...next.memory, seen: [...next.memory.seen, message.id].slice(-haulier.seenCapacity) }, posts: [...carried.posts, ...next.posts] };
  }, { memory, posts: [] });
}

/**
 * The demo's control: the haulier withdraws a truck it has offered, the named offer or else the open one that leaves last. Whatever the
 * ledger holds or has confirmed for it is released, so the capacity is genuinely gone from the case and free for others.
 */
export function withdrawTruck(context: HaulierContext, memory: HaulierMemory, reason: string, offerId?: string): Decision & Readonly<{ withdrawn: OfferRecord | null }> {
  const open = Object.values(memory.offers).filter(record => record.status === 'open');
  const target = offerId ? open.find(record => record.offer.id === offerId) : open.sort((a, b) => ms(b.truck.departs) - ms(a.truck.departs))[0];
  if (!target) return { memory, posts: [], withdrawn: null };
  const booking = context.ledger.find(bookingKey(target.caseId, target.offer.id));
  if (booking) context.ledger.release(booking.id);
  return { ...withdraw(context, memory, target, reason), withdrawn: target };
}
