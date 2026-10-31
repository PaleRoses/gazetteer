import type { RecoveryMessage } from '../../../core/recovery.js';
import type { Phrase } from '../../assessment/mind';
import type { CaseState } from './negotiate.js';

type PlanMessage = Extract<RecoveryMessage, { kind: 'recovery.plan' }>;
const numbers = (text: string): readonly string[] => text.match(/\d+(?:[.:]\d+)*/g) ?? [];

/** Pure: the mind's words are kept only if every number in them was given to it; anything invented and the rule-based words stand. */
export const quotesOnlyGiven = (words: string, given: string): boolean => numbers(words).every(token => numbers(given).includes(token));

/** Pure: what the cargo mind is asked, and everything it may quote: the solver's verdict, the rule-based words, the commitments and the offers cited. */
export function wordingRequest(state: CaseState, plan: PlanMessage): Readonly<{ system: string; prompt: string }> {
  const { container, vessel, deliverBy, budgetEur, reefer, arrival } = state.commitments;
  const cited = state.offers.filter(item => plan.answers.includes(item.messageId)).map(item => item.offer);
  return {
    system: [
      `You are the cargo agent for container ${container} aboard ${vessel}.`,
      'A deterministic solver has already decided the recovery plan below; you decide nothing. Say what it found in one plain sentence for the team,',
      'at most 280 characters, quoting only the times, prices and ids in the input. Return it as structured output.',
    ].join(' '),
    prompt: JSON.stringify({ outcome: plan.outcome, ruleBasedWords: plan.summary, commitments: { arrival, deliverBy, budgetEur, reefer }, offers: cited }, null, 2),
  };
}

/**
 * The cargo mind words its plans when it can: each new recovery.plan goes through the mind, and its words replace the rule-based ones only when they
 * quote nothing they were not given; the message is then labelled ai-assessed. The decision itself is always the solver's.
 */
export async function wordPlans(state: CaseState, messages: readonly RecoveryMessage[], phrase: Phrase, session: string | null): Promise<Readonly<{ messages: readonly RecoveryMessage[]; session: string | null }>> {
  return messages.reduce<Promise<Readonly<{ messages: readonly RecoveryMessage[]; session: string | null }>>>(async (previous, message) => {
    const done = await previous;
    if (message.kind !== 'recovery.plan') return { ...done, messages: [...done.messages, message] };
    const request = wordingRequest(state, message);
    const said = await phrase({ ...request, session: done.session });
    const kept = said.status === 'ok' && quotesOnlyGiven(said.text, request.prompt) ? { ...message, summary: said.text, method: 'ai-assessed' as const } : message;
    return { messages: [...done.messages, kept], session: said.session };
  }, Promise.resolve({ messages: [], session }));
}
