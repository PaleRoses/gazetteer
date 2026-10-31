import {
  bookingKey, describeConstraint, fit, remedyFor, type Commitments, type Constraint, type Offer, type Plan, type RecoveryMessage, type Remedy,
} from '../../../core/recovery';

/** One sandbox booking the case holds, keyed by caseId and offerId so that replaying a decision never books twice. */
export type Booking = Readonly<{ offerId: string; key: string; status: 'held' | 'confirmed' | 'released' }>;
export type CaseState = Readonly<{
  caseId: string; agent: Readonly<{ id: string; vessel: string }>; commitments: Commitments;
  /** Offers heard, by id, with the message that carried each (what a reply cites). */
  offers: readonly Readonly<{ offer: Offer; messageId: string }>[];
  withdrawn: readonly string[]; bookings: readonly Booking[]; plan: Plan | null; posted: readonly string[];
}>;
/** What the ledger is asked to do; every action is idempotent by its key. */
export type LedgerAction =
  | Readonly<{ kind: 'hold'; key: string; offerId: string; caseId: string; resource: string; start: string; end: string; priceEur: number; expiresAt: string }>
  | Readonly<{ kind: 'confirm'; key: string; offerId: string }>
  | Readonly<{ kind: 'release'; key: string; offerId: string }>;
export type Decision = Readonly<{ state: CaseState; messages: readonly RecoveryMessage[]; actions: readonly LedgerAction[] }>;
export type Method = 'ai-assessed' | 'rule-based';

export const openCase = (caseId: string, agent: CaseState['agent'], commitments: Commitments): CaseState =>
  ({ caseId, agent, commitments, offers: [], withdrawn: [], bookings: [], plan: null, posted: [] });

const hours = (at: string, h: number): string => new Date(Date.parse(at) + h * 3_600_000).toISOString();
const author = (state: CaseState) => ({ role: 'cargo' as const, id: state.agent.id, vessel: state.agent.vessel });
const terminal = (state: CaseState) => ({ role: 'city' as const, city: state.commitments.port, element: 'terminal' as const });
const haulier = (state: CaseState) => ({ role: 'haulier' as const, city: state.commitments.port });
const live = (state: CaseState): readonly Offer[] => state.offers.filter(item => !state.withdrawn.includes(item.offer.id)).map(item => item.offer);
const citing = (state: CaseState, offerIds: readonly string[]): readonly string[] =>
  offerIds.flatMap(offerId => state.offers.filter(item => item.offer.id === offerId).map(item => item.messageId));
const blockingIds = (blocking: Constraint): readonly string[] => {
  switch (blocking.kind) {
    case 'truck-before-unload': return [blocking.truck, blocking.unload];
    case 'unload-before-arrival': return [blocking.unload];
    case 'storage-gap': return blocking.storage ? [blocking.storage] : [];
    case 'misses-deadline': return [blocking.truck];
    case 'missing': case 'over-budget': return [];
  }
};

/** Pure: take in what was heard for this case. Offers are replaced by id; a withdrawal is permanent. */
export function hear(state: CaseState, heard: readonly RecoveryMessage[]): CaseState {
  const mine = heard.filter(message => message.caseId === state.caseId);
  const offers = mine.flatMap(message => message.kind === 'recovery.offer' ? [{ offer: message.offer, messageId: message.id }] : []);
  const withdrawn = mine.flatMap(message => message.kind === 'recovery.withdraw' ? [message.offerId] : []);
  return {
    ...state,
    offers: [...new Map([...state.offers, ...offers].map(item => [item.offer.id, item] as const)).values()],
    withdrawn: [...new Set([...state.withdrawn, ...withdrawn])],
  };
}

const request = (state: CaseState, now: string, remedy: Remedy, answers: readonly string[], summary: string, why: string): RecoveryMessage => ({
  id: `${state.caseId}/request/${why}/${remedy.service}`, kind: 'recovery.request', at: now, caseId: state.caseId,
  author: author(state), to: remedy.to === 'haulier' ? haulier(state) : terminal(state), service: remedy.service, answers: [...answers], summary,
  ...(remedy.after ? { after: remedy.after } : {}), ...(remedy.until ? { until: remedy.until } : {}), ...(remedy.service === 'storage' ? { powered: state.commitments.reefer } : {}),
});

/** The opening asks: an unload window and (for a reefer) powered storage from the terminal, a truck from the haulier, all after the revised arrival. */
const opening = (state: CaseState, now: string): readonly RecoveryMessage[] => {
  const { arrival, reefer, container } = state.commitments;
  return [
    request(state, now, { to: 'terminal', service: 'unload', after: arrival }, [], `${container}: unloading window after ${arrival.slice(11, 16)}Z, please.`, 'open'),
    ...(reefer ? [request(state, now, { to: 'terminal', service: 'storage', after: arrival }, [], `${container} is a reefer: powered storage from unload until pickup, please.`, 'open')] : []),
    request(state, now, { to: 'haulier', service: 'truck', after: arrival }, [], `${container}: a truck after ${arrival.slice(11, 16)}Z, please.`, 'open'),
  ];
};

const resourceWindow = (offer: Offer, transitHours: number): Readonly<{ start: string; end: string }> => {
  switch (offer.service) {
    case 'unload': return { start: offer.at, end: hours(offer.at, 1) };
    case 'storage': return { start: offer.from, end: offer.until };
    case 'truck': return { start: offer.departs, end: hours(offer.departs, Math.max(transitHours, 1)) };
  }
};

const unseen = (state: CaseState, messages: readonly RecoveryMessage[]): readonly RecoveryMessage[] => messages.filter(message => !state.posted.includes(message.id));
const post = (state: CaseState, messages: readonly RecoveryMessage[]): Decision => {
  const fresh = unseen(state, messages);
  return { state: { ...state, posted: [...state.posted, ...fresh.map(message => message.id)] }, messages: fresh, actions: [] };
};

/**
 * Pure, and the same on replay: the deterministic negotiator. Ask, fit, then hold, confirm and release what the fitting plan needs.
 * Message ids and booking keys derive from the case, so a restarted agent re-decides the same ids and keys and nothing is posted or booked twice.
 * While no plan fits, every booking is kept: a working arrangement is never discarded for one that does not exist yet.
 */
export function negotiate(state: CaseState, now: string, method: Method = 'rule-based'): Decision {
  if (!state.posted.some(id => id.startsWith(`${state.caseId}/request/`))) return post(state, opening(state, now));
  const result = fit(state.commitments, live(state), now);
  if ('blocking' in result) {
    const { blocking } = result;
    const answers = citing(state, blockingIds(blocking));
    const words = describeConstraint(blocking);
    const round = `r${state.withdrawn.length}/${blocking.kind}/${blockingIds(blocking).join('+') || 'none'}`;
    const planned: RecoveryMessage = {
      id: `${state.caseId}/plan/blocked/${round}`, kind: 'recovery.plan', at: now, caseId: state.caseId,
      author: author(state), method, outcome: { status: 'blocked', blocking }, answers: [...answers], summary: `Blocked: ${words}`.slice(0, 280),
    };
    const remedy = remedyFor(blocking);
    const voided = state.bookings.flatMap((item): LedgerAction[] => item.status !== 'released' && state.withdrawn.includes(item.offerId) ? [{ kind: 'release', key: item.key, offerId: item.offerId }] : []);
    const decided = post({ ...state, plan: null }, [planned, ...(remedy ? [request(state, now, remedy, [planned.id, ...answers], `${words} Can you change that?`.slice(0, 280), round)] : [])]);
    return { ...decided, actions: voided };
  }
  const { plan } = result;
  const fresh = state.plan === null || state.plan.offerIds.join() !== plan.offerIds.join();
  const announced: readonly RecoveryMessage[] = fresh ? [{
    id: `${state.caseId}/plan/fits/${plan.offerIds.join('+')}`, kind: 'recovery.plan', at: now, caseId: state.caseId, author: author(state), method,
    outcome: { status: 'fits', plan }, answers: [...citing(state, plan.offerIds)],
    summary: `Fits: unloaded ${plan.ready.slice(11, 16)}Z, truck ${plan.departs.slice(11, 16)}Z, delivered ${plan.delivered.slice(0, 16)}Z, EUR ${plan.totalEur}.`,
  }] : [];
  const booking = (offerId: string): Booking | undefined => state.bookings.find(item => item.offerId === offerId && item.status !== 'released');
  const offerOf = (offerId: string): Offer | undefined => live(state).find(item => item.id === offerId);
  const holds = plan.offerIds.flatMap((offerId): LedgerAction[] => {
    const offer = offerOf(offerId);
    if (booking(offerId) || !offer) return [];
    return [{ kind: 'hold', key: bookingKey(state.caseId, offerId), offerId, caseId: state.caseId, resource: offerId, ...resourceWindow(offer, state.commitments.transitHours), priceEur: offer.priceEur, expiresAt: offer.expiresAt }];
  });
  const allHeld = holds.length === 0;
  const confirms = allHeld ? plan.offerIds.flatMap((offerId): LedgerAction[] => booking(offerId)?.status === 'held' ? [{ kind: 'confirm', key: bookingKey(state.caseId, offerId), offerId }] : []) : [];
  const releases = allHeld ? state.bookings.flatMap((item): LedgerAction[] => item.status !== 'released' && !plan.offerIds.includes(item.offerId) ? [{ kind: 'release', key: item.key, offerId: item.offerId }] : []) : [];
  const posted = post({ ...state, plan }, announced);
  return { ...posted, actions: [...holds, ...confirms, ...releases] };
}

export type LedgerOutcome = Readonly<{ action: LedgerAction; ok: boolean; expiresAt?: string }>;

/** Pure: what the ledger acknowledged becomes the case's bookings and the board's hold, confirm and release messages, each citing the offer it acts on. */
export function settle(state: CaseState, outcomes: readonly LedgerOutcome[], now: string): Decision {
  const done = outcomes.filter(outcome => outcome.ok);
  const status = (action: LedgerAction): Booking['status'] => action.kind === 'hold' ? 'held' : action.kind === 'confirm' ? 'confirmed' : 'released';
  const bookings = done.reduce<readonly Booking[]>((current, { action }) => [
    ...current.filter(item => item.offerId !== action.offerId),
    { offerId: action.offerId, key: action.key, status: status(action) },
  ], state.bookings);
  const message = ({ action, expiresAt }: LedgerOutcome): RecoveryMessage => {
    const base = { id: `${state.caseId}/${action.kind}/${action.offerId}`, at: now, caseId: state.caseId, author: author(state), answers: [...citing(state, [action.offerId])], offerId: action.offerId, key: action.key };
    switch (action.kind) {
      case 'hold': return { ...base, kind: 'recovery.hold', expiresAt: expiresAt ?? action.expiresAt, summary: `Holding ${action.offerId} until ${(expiresAt ?? action.expiresAt).slice(11, 16)}Z.` };
      case 'confirm': return { ...base, kind: 'recovery.confirm', summary: `Confirmed ${action.offerId}.` };
      case 'release': return { ...base, kind: 'recovery.release', summary: `Released ${action.offerId}: the plan no longer needs it.` };
    }
  };
  return post({ ...state, bookings }, done.map(message));
}
