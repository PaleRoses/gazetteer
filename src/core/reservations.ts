import type { Plan } from './recovery.js';

/** One sandbox reservation as the ledger records it. A hold is `held` until confirmed, released or expired. */
type ReservationRecord = Readonly<{
  id: string; caseId: string; resource: string; start: string; end: string; priceEur: number;
  status: 'held' | 'confirmed' | 'released' | 'expired'; expiresAt: string; heldBy: string; confirmedAt: string | null;
}>;

/** The cargo agent's case: the plan that fits (null while none does) and the delivery it recovers. Deterministic negotiation is labelled rule-based. */
export type RecoveryCase = Readonly<{ caseId: string; method: 'rule-based'; plan: Plan | null; delivered: string | null }>;

/** Act 2 on the dashboard: the case as the cargo agent last reported it, and every reservation of the workspace. */
export type RecoveryView = Readonly<{ case: RecoveryCase | null; reservations: readonly ReservationRecord[] }>;
