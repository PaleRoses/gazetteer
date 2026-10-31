import type { RecoveryMessage } from '../../../core/recovery.js';
import { negotiate, settle, type CaseState } from './negotiate.js';

const maxSteps = 4;
/**
 * One check to quiet: negotiate and post, again while there is something to do. The ledger is read once, before the cycle, so holds posted here are
 * `requested` until the next check reads them back, and their confirms follow only then.
 */
export const cycle = (state: CaseState, now: string, steps = maxSteps, said: readonly RecoveryMessage[] = []): Readonly<{ state: CaseState; messages: readonly RecoveryMessage[] }> => {
  const decided = negotiate(state, now);
  const settled = settle(decided.state, decided.actions, now);
  const messages = [...said, ...decided.messages, ...settled.messages];
  return decided.actions.length === 0 || steps <= 1 ? { state: settled.state, messages } : cycle(settled.state, now, steps - 1, messages);
};
