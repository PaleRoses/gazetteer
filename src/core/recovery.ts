import { z } from 'zod';
import { portIds } from './ports.js';

const portId = z.enum(portIds);
const instant = z.iso.datetime();
const euros = z.number().nonnegative();

export const cargoAuthor = z.object({ role: z.literal('cargo'), id: z.string().min(1), vessel: z.string().min(1) });
export const terminalAuthor = z.object({ role: z.literal('city'), city: portId, element: z.literal('terminal') });
export const haulierAuthor = z.object({ role: z.literal('haulier'), city: portId });
export const providerAuthor = z.union([terminalAuthor, haulierAuthor]);
export const recoveryAuthor = z.union([cargoAuthor, terminalAuthor, haulierAuthor]);

/** What the cargo agent remembers it owes: the deadline at the consignee, the haul, the budget, and whether the box needs power. */
export const commitments = z.object({
  cargoId: z.string().min(1), shipmentId: z.string().min(1), vessel: z.string().min(1), container: z.string().min(1),
  port: portId, arrival: instant, deliverBy: instant, transitHours: z.number().nonnegative(), budgetEur: euros, reefer: z.boolean(),
  truckAppointment: instant,
});

const terms = { id: z.string().min(1), priceEur: euros, expiresAt: instant };
export const offer = z.discriminatedUnion('service', [
  z.object({ ...terms, service: z.literal('unload'), provider: terminalAuthor, at: instant }),
  z.object({ ...terms, service: z.literal('storage'), provider: terminalAuthor, powered: z.boolean(), from: instant, until: instant }),
  z.object({ ...terms, service: z.literal('truck'), provider: haulierAuthor, departs: instant }),
]);
export const service = z.enum(['unload', 'storage', 'truck']);

/** The first thing that stops the best combination on offer: what the cargo agent must ask someone to change. */
export const constraint = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('missing'), service }),
  z.object({ kind: z.literal('unload-before-arrival'), unload: z.string(), at: instant, arrival: instant }),
  z.object({ kind: z.literal('truck-before-unload'), truck: z.string(), unload: z.string(), departs: instant, ready: instant }),
  z.object({ kind: z.literal('storage-gap'), storage: z.string().nullable(), needFrom: instant, needUntil: instant }),
  z.object({ kind: z.literal('misses-deadline'), truck: z.string(), delivered: instant, deliverBy: instant }),
  z.object({ kind: z.literal('over-budget'), totalEur: euros, budgetEur: euros }),
]);

export const plan = z.object({
  unload: z.string(), storage: z.string().nullable(), truck: z.string(),
  ready: instant, departs: instant, delivered: instant, totalEur: euros, offerIds: z.array(z.string()),
});

export type Commitments = z.infer<typeof commitments>;
export type Offer = z.infer<typeof offer>;
export type Service = z.infer<typeof service>;
export type Constraint = z.infer<typeof constraint>;
export type Plan = z.infer<typeof plan>;
export type Fit = Readonly<{ plan: Plan }> | Readonly<{ blocking: Constraint }>;
type Unload = Extract<Offer, { service: 'unload' }>;
type Storage = Extract<Offer, { service: 'storage' }>;
type Truck = Extract<Offer, { service: 'truck' }>;

/** The idempotency key of every hold and booking: one per case and offer, so a restarted agent can never book twice. */
export const bookingKey = (caseId: string, offerId: string): string => `${caseId}:${offerId}`;

const ms = Date.parse;
const hours = (at: string, h: number): string => new Date(ms(at) + h * 3_600_000).toISOString();

type Checked = Readonly<{ ok: true; plan: Plan }> | Readonly<{ ok: false; rank: number; blocking: Constraint }>;

/** Pure: one combination against the commitments, checked in the order a person would: arrival, handover, power, deadline, money. */
function check(c: Commitments, unload: Unload, truck: Truck, storage: Storage | null): Checked {
  if (ms(unload.at) < ms(c.arrival)) return { ok: false, rank: 0, blocking: { kind: 'unload-before-arrival', unload: unload.id, at: unload.at, arrival: c.arrival } };
  if (ms(truck.departs) < ms(unload.at)) return { ok: false, rank: 1, blocking: { kind: 'truck-before-unload', truck: truck.id, unload: unload.id, departs: truck.departs, ready: unload.at } };
  const covered = storage !== null && (!c.reefer || storage.powered) && ms(storage.from) <= ms(unload.at) && ms(storage.until) >= ms(truck.departs);
  if (c.reefer && !covered) return { ok: false, rank: 2, blocking: { kind: 'storage-gap', storage: storage?.id ?? null, needFrom: unload.at, needUntil: truck.departs } };
  const delivered = hours(truck.departs, c.transitHours);
  if (ms(delivered) > ms(c.deliverBy)) return { ok: false, rank: 3, blocking: { kind: 'misses-deadline', truck: truck.id, delivered, deliverBy: c.deliverBy } };
  const used = [unload, ...(covered && storage ? [storage] : []), truck];
  const totalEur = used.reduce((sum, item) => sum + item.priceEur, 0);
  if (totalEur > c.budgetEur) return { ok: false, rank: 4, blocking: { kind: 'over-budget', totalEur, budgetEur: c.budgetEur } };
  return { ok: true, plan: { unload: unload.id, storage: covered && storage ? storage.id : null, truck: truck.id, ready: unload.at, departs: truck.departs, delivered, totalEur, offerIds: used.map(item => item.id) } };
}

const better = (a: Plan, b: Plan): Plan =>
  ms(a.delivered) !== ms(b.delivered) ? (ms(a.delivered) < ms(b.delivered) ? a : b) : a.totalEur <= b.totalEur ? a : b;

/**
 * Pure: the earliest-delivered, then cheapest, plan the live offers allow; otherwise the blocking constraint of the combination that got furthest.
 * Offers past their expiry at `now` do not exist. Ties keep input order, so the answer is deterministic.
 */
export function fit(c: Commitments, offers: readonly Offer[], now: string): Fit {
  const live = offers.filter(item => ms(item.expiresAt) > ms(now));
  const unloads = live.filter((item): item is Unload => item.service === 'unload');
  const trucks = live.filter((item): item is Truck => item.service === 'truck');
  const storages = live.filter((item): item is Storage => item.service === 'storage');
  if (!unloads.length) return { blocking: { kind: 'missing', service: 'unload' } };
  if (!trucks.length) return { blocking: { kind: 'missing', service: 'truck' } };
  const candidates: readonly (Storage | null)[] = [...storages, null];
  const checked = unloads.flatMap(unload => trucks.flatMap(truck => candidates.map(storage => check(c, unload, truck, storage))));
  const plans = checked.flatMap(item => item.ok ? [item.plan] : []);
  const [first, ...rest] = plans;
  if (first) return { plan: rest.reduce(better, first) };
  const furthest = checked.reduce<Checked | null>((best, item) => !item.ok && (!best || (!best.ok && item.rank > best.rank)) ? item : best, null);
  return furthest && !furthest.ok ? { blocking: furthest.blocking } : { blocking: { kind: 'missing', service: 'unload' } };
}

const clock = (at: string): string => at.slice(11, 16);

/** The deterministic negotiator's words for a constraint, quoting only its own numbers. */
export function describeConstraint(blocking: Constraint): string {
  switch (blocking.kind) {
    case 'missing': return `No live ${blocking.service} offer.`;
    case 'unload-before-arrival': return `The unload window at ${clock(blocking.at)}Z is before the ship arrives at ${clock(blocking.arrival)}Z.`;
    case 'truck-before-unload': return `The truck leaves at ${clock(blocking.departs)}Z, before the container is unloaded at ${clock(blocking.ready)}Z.`;
    case 'storage-gap': return `The reefer needs powered storage from ${clock(blocking.needFrom)}Z to ${clock(blocking.needUntil)}Z.`;
    case 'misses-deadline': return `Delivery at ${blocking.delivered.slice(0, 16)}Z misses the ${blocking.deliverBy.slice(0, 16)}Z deadline.`;
    case 'over-budget': return `The plan costs EUR ${blocking.totalEur}, over the EUR ${blocking.budgetEur} budget.`;
  }
}

export type Remedy = Readonly<{ to: 'terminal' | 'haulier'; service: Service; after?: string; until?: string }>;

/** The deterministic negotiator's next ask: who must change what for the blocking constraint to clear. Null when no ask can clear it. */
export function remedyFor(blocking: Constraint): Remedy | null {
  switch (blocking.kind) {
    case 'missing': return { to: blocking.service === 'truck' ? 'haulier' : 'terminal', service: blocking.service };
    case 'unload-before-arrival': return { to: 'terminal', service: 'unload', after: blocking.arrival };
    case 'truck-before-unload': return { to: 'haulier', service: 'truck', after: blocking.ready };
    case 'storage-gap': return { to: 'terminal', service: 'storage', after: blocking.needFrom, until: blocking.needUntil };
    case 'misses-deadline': return null;
    case 'over-budget': return null;
  }
}

const envelope = { id: z.string().min(1), at: instant, summary: z.string().min(1).max(280), caseId: z.string().min(1), answers: z.array(z.string()) };

export const recoveryRequest = z.object({ ...envelope, kind: z.literal('recovery.request'), author: cargoAuthor, to: providerAuthor, service, after: instant.optional(), until: instant.optional(), powered: z.boolean().optional() });
export const recoveryOffer = z.object({ ...envelope, kind: z.literal('recovery.offer'), author: providerAuthor, offer });
export const recoveryHold = z.object({ ...envelope, kind: z.literal('recovery.hold'), author: recoveryAuthor, offerId: z.string().min(1), key: z.string().min(1), expiresAt: instant });
export const recoveryWithdraw = z.object({ ...envelope, kind: z.literal('recovery.withdraw'), author: providerAuthor, offerId: z.string().min(1), reason: z.string().min(1) });
export const recoveryPlan = z.object({ ...envelope, kind: z.literal('recovery.plan'), author: cargoAuthor, method: z.enum(['ai-assessed', 'rule-based']), outcome: z.union([z.object({ status: z.literal('fits'), plan }), z.object({ status: z.literal('blocked'), blocking: constraint })]) });
export const recoveryConfirm = z.object({ ...envelope, kind: z.literal('recovery.confirm'), author: recoveryAuthor, offerId: z.string().min(1), key: z.string().min(1) });
export const recoveryRelease = z.object({ ...envelope, kind: z.literal('recovery.release'), author: recoveryAuthor, offerId: z.string().min(1), key: z.string().min(1) });

export const recoveryMessage = z.discriminatedUnion('kind', [recoveryRequest, recoveryOffer, recoveryHold, recoveryWithdraw, recoveryPlan, recoveryConfirm, recoveryRelease]);
export type RecoveryMessage = z.infer<typeof recoveryMessage>;
export type RecoveryKind = RecoveryMessage['kind'];
export type RecoveryAuthor = z.infer<typeof recoveryAuthor>;
