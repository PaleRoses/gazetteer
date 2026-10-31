import { describe, expect, test } from 'bun:test';
import { countdown, currentBlocker, litSteps, recoveryThread, type RecoveryPost } from '../../src/client/recovery-view';
import { fixtureBulletin } from './society-fixture';

const cargo = { role: 'cargo', id: 'MSTU 000000 0', vessel: 'Fixture Star' } as const;
const terminal = { role: 'city', city: 'rotterdam', element: 'terminal' } as const;
const haulier = { role: 'haulier', city: 'rotterdam' } as const;
const at = (minute: number): string => `2026-10-31T12:${String(minute).padStart(2, '0')}:00.000Z`;
const envelope = (id: string, minute: number, answers: readonly string[] = [], caseId = 'case-1') => ({ id, at: at(minute), summary: `Synthetic ${id}`, caseId, answers: [...answers] });

const request: RecoveryPost = { ...envelope('request', 1), kind: 'recovery.request', author: cargo, to: terminal, service: 'unload' };
const offer: RecoveryPost = { ...envelope('offer', 2, ['request']), kind: 'recovery.offer', author: terminal, offer: { id: 'unload-1', service: 'unload', provider: terminal, at: at(40), priceEur: 140, expiresAt: at(50) } };
const blocked: RecoveryPost = { ...envelope('blocked', 3, ['offer']), kind: 'recovery.plan', author: cargo, method: 'rule-based', outcome: { status: 'blocked', blocking: { kind: 'missing', service: 'truck' } } };
const confirm: RecoveryPost = { ...envelope('confirm', 5), kind: 'recovery.confirm', author: cargo, offerId: 'unload-1', key: 'case-1:unload-1' };
const withdraw: RecoveryPost = { ...envelope('withdraw', 6), kind: 'recovery.withdraw', author: haulier, offerId: 'truck-1', reason: 'Synthetic withdrawal' };
const fits: RecoveryPost = { ...envelope('fits', 7, ['withdraw']), kind: 'recovery.plan', author: cargo, method: 'rule-based', outcome: { status: 'fits', plan: { unload: 'unload-1', storage: null, truck: 'truck-2', ready: at(40), departs: at(45), delivered: at(59), totalEur: 860, offerIds: ['unload-1', 'truck-2'] } } };
const otherCase: RecoveryPost = { ...envelope('other', 0, [], 'case-2'), kind: 'recovery.request', author: cargo, to: haulier, service: 'truck' };

describe('the act-2 negotiation', () => {
  test("the thread is the case's recovery posts, oldest first, each with the posts it answers", () => {
    const thread = recoveryThread([blocked, fixtureBulletin, offer, otherCase, request], 'case-1');
    expect(thread.map(item => item.post.id)).toEqual(['request', 'offer', 'blocked']);
    expect(thread[1]?.answers.map(message => message.id)).toEqual(['request']);
    expect(recoveryThread([offer], 'case-1')[0]?.answers).toEqual([]);
  });

  test('steps light only from the posts that reach them', () => {
    const early = recoveryThread([request, offer, blocked], 'case-1');
    expect([...litSteps(early, true, null)]).toEqual(['delay', 'ask', 'blocker']);
    expect([...litSteps([], false, null)]).toEqual([]);
    const late = recoveryThread([request, offer, blocked, confirm, withdraw, fits], 'case-1');
    expect([...litSteps(late, true, null)]).toEqual(['delay', 'ask', 'blocker', 'book', 'adapt']);
  });

  test('a restart counts only once the cargo agent posts after it', () => {
    const thread = recoveryThread([request, confirm, withdraw, fits], 'case-1');
    expect(litSteps(thread, true, at(6)).has('restart')).toBe(true);
    expect(litSteps(thread, true, at(8)).has('restart')).toBe(false);
    expect(litSteps(recoveryThread([request, withdraw], 'case-1'), true, at(5)).has('restart')).toBe(false);
  });

  test('the blocker is the latest plan’s, and clears once a plan fits', () => {
    expect(currentBlocker(recoveryThread([request, blocked], 'case-1'))).toEqual({ kind: 'missing', service: 'truck' });
    expect(currentBlocker(recoveryThread([request, blocked, fits], 'case-1'))).toBeNull();
    expect(currentBlocker([])).toBeNull();
  });

  test('a hold counts down in minutes and seconds and stops at expiry', () => {
    const now = Date.parse(at(10));
    expect(countdown(new Date(now + 125_000).toISOString(), now)).toBe('2:05');
    expect(countdown(at(10), now)).toBeNull();
    expect(countdown(at(9), now)).toBeNull();
  });
});
