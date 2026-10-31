import { describe, expect, test } from 'bun:test';
import type { Commitments, Offer, RecoveryMessage } from '../../../../src/core/recovery';
import type { Phrase } from '../../../../src/server/assessment/mind';
import { hear, negotiate, openCase } from '../../../../src/server/agents/cargo/negotiate';
import { quotesOnlyGiven, wordPlans } from '../../../../src/server/agents/cargo/voice';

const now = '2026-10-31T14:00:00.000Z';
const later = '2026-10-31T23:00:00.000Z';
const terminal = { role: 'city', city: 'rotterdam', element: 'terminal' } as const;
const haulier = { role: 'haulier', city: 'rotterdam' } as const;
const commitments: Commitments = {
  cargoId: 'cargo-reefer-1', shipmentId: 'meridian', vessel: 'Meridian Star', container: 'MSCU1234565', port: 'rotterdam',
  arrival: '2026-10-31T17:30:00.000Z', deliverBy: '2026-11-01T02:00:00.000Z', transitHours: 4, budgetEur: 1500, reefer: true, truckAppointment: '2026-10-31T17:00:00.000Z',
};
const offer = (o: Offer): RecoveryMessage => ({ id: `m-${o.id}`, kind: 'recovery.offer', at: now, caseId: 'case-1', author: o.provider, offer: o, answers: [], summary: o.id });
const blocked = () => {
  const opened = negotiate(openCase('case-1', { id: 'cargo-reefer-1', vessel: 'Meridian Star' }, commitments), now).state;
  const state = hear(opened, [
    offer({ id: 'unload-18', service: 'unload', provider: terminal, at: '2026-10-31T18:00:00.000Z', priceEur: 400, expiresAt: later }),
    offer({ id: 'plug', service: 'storage', provider: terminal, powered: true, from: '2026-10-31T18:00:00.000Z', until: '2026-10-31T20:00:00.000Z', priceEur: 150, expiresAt: later }),
    offer({ id: 'truck-17', service: 'truck', provider: haulier, departs: '2026-10-31T17:00:00.000Z', priceEur: 600, expiresAt: later }),
  ]);
  return negotiate(state, now);
};
const saying = (text: string): Readonly<{ phrase: Phrase; sessions: (string | null)[] }> => {
  const sessions: (string | null)[] = [];
  return { phrase: async ({ session }) => { sessions.push(session); return { status: 'ok', text, session: 'cargo-voyage-1' }; }, sessions };
};

describe('the cargo mind words plans and decides nothing', () => {
  test('words that quote only what it was given replace the rule-based ones and are labelled ai-assessed; the outcome is the solver\'s', async () => {
    const decided = blocked();
    const { phrase, sessions } = saying('The 17:00 truck leaves before the 18:00 unload; we need a later truck from the haulier.');
    const voiced = await wordPlans(decided.state, decided.messages, phrase, null);
    const plan = voiced.messages.find(message => message.kind === 'recovery.plan');
    const original = decided.messages.find(message => message.kind === 'recovery.plan');
    expect(plan).toMatchObject({ method: 'ai-assessed', summary: 'The 17:00 truck leaves before the 18:00 unload; we need a later truck from the haulier.' });
    expect(plan && original && plan.kind === 'recovery.plan' && original.kind === 'recovery.plan' ? [plan.id, plan.outcome] : null).toEqual(original && original.kind === 'recovery.plan' ? [original.id, original.outcome] : null);
    expect(voiced.messages.filter(message => message.kind === 'recovery.request')).toEqual(decided.messages.filter(message => message.kind === 'recovery.request'));
    expect([voiced.session, sessions]).toEqual(['cargo-voyage-1', [null]]);
  });
  test('words with a number it was never given are dropped, and the rule-based words stand', async () => {
    const decided = blocked();
    const voiced = await wordPlans(decided.state, decided.messages, saying('The truck leaves at 16:45, so we will pay EUR 900 for a new one.').phrase, null);
    expect(voiced.messages.find(message => message.kind === 'recovery.plan')).toMatchObject({ method: 'rule-based', summary: expect.stringContaining('The truck leaves at 17:00Z') });
  });
  test('without a mind the rule-based plan goes out unchanged', async () => {
    const decided = blocked();
    const none: Phrase = async ({ session }) => ({ status: 'failed', message: 'no mind', session });
    expect((await wordPlans(decided.state, decided.messages, none, null)).messages).toEqual(decided.messages);
  });
  test('the number guard', () => {
    expect(quotesOnlyGiven('Unload 18:00, truck 19:30, EUR 1200.', '{"a":"18:00","b":"19:30","c":1200}')).toBe(true);
    expect(quotesOnlyGiven('Truck at 19:45.', '{"b":"19:30"}')).toBe(false);
  });
});
