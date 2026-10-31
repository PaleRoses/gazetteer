import type { RecoveryMessage } from '../../../core/recovery.js';
import type { Bookings } from '../../booking/ledger';
import { negotiate, settle, type CaseState, type LedgerAction, type LedgerOutcome } from './negotiate.js';

/** The effect edge: the cargo agent owns the ledger writes, each idempotent by its key; the offer id is the resource, so two cases cannot hold one truck. */
export const executeOn = (ledger: Pick<Bookings, 'hold' | 'confirm' | 'release' | 'find'>, workspaceId: string, heldBy: string) => (action: LedgerAction): LedgerOutcome => {
  switch (action.kind) {
    case 'hold': return { action, ok: ledger.hold({ key: action.key, workspaceId, caseId: action.caseId, resource: action.resource, start: action.start, end: action.end, priceEur: action.priceEur, expiresAt: action.expiresAt, heldBy }).ok };
    case 'confirm': { const booking = ledger.find(action.key); return { action, ok: booking ? ledger.confirm(booking.id).ok : false }; }
    case 'release': { const booking = ledger.find(action.key); return { action, ok: booking ? ledger.release(booking.id).ok : true }; }
  }
};

const maxSteps = 4;
/** One cycle to quiet: negotiate, write the ledger, settle, again while there is something to do; a hold, its confirm and the releases land together. */
export const cycle = (state: CaseState, now: string, run: (action: LedgerAction) => LedgerOutcome, steps = maxSteps, said: readonly RecoveryMessage[] = []): Readonly<{ state: CaseState; messages: readonly RecoveryMessage[] }> => {
  const decided = negotiate(state, now);
  const settled = settle(decided.state, decided.actions.map(run), now);
  const messages = [...said, ...decided.messages, ...settled.messages];
  return decided.actions.length === 0 || steps <= 1 ? { state: settled.state, messages } : cycle(settled.state, now, run, steps - 1, messages);
};
