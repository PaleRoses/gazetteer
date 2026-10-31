import { describe, expect, test } from 'bun:test';
import { bookingKey, type Offer, type RecoveryMessage } from '../../../../src/core/recovery';
import type { TerminalRequest } from '../../../../src/core/services';
import { emptyTerminalMemory, hear, type TerminalContext, type TerminalMemory } from '../../../../src/server/agents/city/terminal';
import { createBookings } from '../../../../src/server/booking/ledger';

const day = '2026-10-31T';
const t = (clock: string): string => `${day}${clock}:00.000Z`;
const now = t('16:30');
const provider = { role: 'city', city: 'rotterdam', element: 'terminal' } as const;
const cargo = { role: 'cargo', id: 'cargo-1', vessel: 'Meridian Star' } as const;

/** Fixture of the world's Rotterdam desk until core/services.ts lands: one crane window at 18:00 for EUR 140, plug R-114 free 18:00 to midnight at EUR 95 an hour, one hour minimum. */
const quote = (at: string) => (ask: TerminalRequest): Offer | null => {
  const expiresAt = new Date(Date.parse(at) + 30 * 60_000).toISOString();
  const after = ask.after ?? at;
  if (ask.service === 'unload') return Date.parse(t('18:00')) >= Date.parse(after) ? { service: 'unload', id: 'rotterdam:unload:unload-1800', provider, at: t('18:00'), priceEur: 140, expiresAt } : null;
  const from = Date.parse(after) > Date.parse(t('18:00')) ? new Date(Date.parse(after)).toISOString() : t('18:00');
  const until = ask.until ?? new Date(Date.parse(from) + 3_600_000).toISOString();
  const hours = Math.max(1, (Date.parse(until) - Date.parse(from)) / 3_600_000);
  return { service: 'storage', id: `rotterdam:storage:R-114:${from}/${until}`, provider, powered: true, from, until, priceEur: Math.round(hours * 95 * 100) / 100, expiresAt };
};
const fresh = () => {
  const ledger = createBookings(':memory:', () => Date.parse(now));
  const context = (at = now): TerminalContext => ({ city: 'rotterdam', workspaceId: 'w1', now: at, quote: quote(at), ledger });
  return { ledger, context };
};
const request = (caseId: string, service: 'unload' | 'storage' | 'truck', extra: Partial<Extract<RecoveryMessage, { kind: 'recovery.request' }>> = {}): RecoveryMessage => ({
  id: `${caseId}/request/${service}/${extra.until ?? extra.after ?? 'open'}`, kind: 'recovery.request', author: cargo, at: now, summary: 'Please.', caseId, answers: [],
  to: service === 'truck' ? { role: 'haulier', city: 'rotterdam' } : provider, service, after: t('16:00'), ...extra,
});
const act = (kind: 'recovery.hold' | 'recovery.confirm' | 'recovery.release', caseId: string, offerId: string): RecoveryMessage => {
  const base = { id: `${caseId}/${kind}/${offerId}`, author: cargo, at: now, summary: kind, caseId, answers: [], offerId, key: bookingKey(caseId, offerId) };
  return kind === 'recovery.hold' ? { ...base, kind, expiresAt: t('17:00') } : { ...base, kind };
};
const offers = (posts: readonly RecoveryMessage[]): readonly Offer[] => posts.flatMap(post => post.kind === 'recovery.offer' ? [post.offer] : []);
const numbers = (text: string): readonly string[] => text.match(/\d+(?:\.\d+)?/g) ?? [];
const unexplained = (message: RecoveryMessage): readonly string[] => {
  const { summary, ...rest } = message;
  const known = new Set(numbers(JSON.stringify(rest)));
  return numbers(summary).filter(token => !known.has(token));
};
const run = (context: TerminalContext, memory: TerminalMemory, messages: readonly RecoveryMessage[]) => hear(context, memory, messages);

describe('the terminal desk answers', () => {
  test('an unload request with the world\'s first window after the arrival, once, citing the request; a truck request is not its to answer', () => {
    const { context } = fresh();
    const first = run(context(), emptyTerminalMemory, [request('case-1', 'unload'), request('case-1', 'truck')]);
    expect(offers(first.posts)).toMatchObject([{ service: 'unload', id: 'rotterdam:unload:unload-1800', at: t('18:00'), priceEur: 140, provider }]);
    expect(first.posts[0]).toMatchObject({ kind: 'recovery.offer', caseId: 'case-1', answers: ['case-1/request/unload/open'], author: provider });
    expect(run(context(), first.memory, [request('case-1', 'unload')]).posts).toEqual([]);
  });

  test('powered storage from the unload window, and a longer interval as a new offer when asked to extend', () => {
    const { context } = fresh();
    const opened = run(context(), emptyTerminalMemory, [request('case-1', 'storage', { powered: true })]);
    expect(offers(opened.posts)).toMatchObject([{ service: 'storage', powered: true, from: t('18:00'), until: t('19:00'), priceEur: 95 }]);
    const extended = run(context(), opened.memory, [request('case-1', 'storage', { after: t('18:00'), until: t('19:30'), powered: true })]);
    expect(offers(extended.posts)).toMatchObject([{ service: 'storage', from: t('18:00'), until: t('19:30'), priceEur: 142.5 }]);
    expect(offers(extended.posts)[0]!.id).not.toBe(offers(opened.posts)[0]!.id);
  });

  test('every number in its summaries is one of the message\'s own fields', () => {
    const { context } = fresh();
    const posts = run(context(), emptyTerminalMemory, [request('case-1', 'unload'), request('case-1', 'storage', { until: t('19:30') })]).posts;
    expect(posts.length).toBe(2);
    posts.forEach(post => expect(unexplained(post)).toEqual([]));
    expect(unexplained({ ...posts[0]!, summary: `${posts[0]!.summary} Crane 7.` })).toEqual(['7']);
  });
});

describe('the terminal desk keeps the ledger', () => {
  test('a hold, a confirm and a release on its offer move the booking under the case\'s key, on the plug itself', () => {
    const { ledger, context } = fresh();
    const opened = run(context(), emptyTerminalMemory, [request('case-1', 'storage')]);
    const offerId = offers(opened.posts)[0]!.id;
    const held = run(context(), opened.memory, [act('recovery.hold', 'case-1', offerId)]);
    expect(ledger.find(bookingKey('case-1', offerId))).toMatchObject({ status: 'held', resource: 'rotterdam:plug:R-114', start: t('18:00'), end: t('19:00'), priceEur: 95 });
    const confirmed = run(context(), held.memory, [act('recovery.confirm', 'case-1', offerId)]);
    expect(ledger.find(bookingKey('case-1', offerId))?.status).toBe('confirmed');
    run(context(), confirmed.memory, [act('recovery.release', 'case-1', offerId)]);
    expect(ledger.find(bookingKey('case-1', offerId))?.status).toBe('released');
  });

  test('never offers capacity held or confirmed for another case', () => {
    const { context } = fresh();
    const a = run(context(), emptyTerminalMemory, [request('case-a', 'unload'), request('case-a', 'storage')]);
    const [unload, storage] = offers(a.posts);
    const booked = run(context(), a.memory, [act('recovery.hold', 'case-a', unload!.id), act('recovery.hold', 'case-a', storage!.id)]);
    const confirmed = run(context(), booked.memory, [act('recovery.confirm', 'case-a', unload!.id), act('recovery.confirm', 'case-a', storage!.id)]);
    expect(run(context(), confirmed.memory, [request('case-b', 'unload'), request('case-b', 'storage')]).posts).toEqual([]);
  });

  test('an extension supersedes the case\'s shorter booking on the plug, and the plug stays the case\'s', () => {
    const { ledger, context } = fresh();
    const opened = run(context(), emptyTerminalMemory, [request('case-1', 'storage')]);
    const short = offers(opened.posts)[0]!.id;
    const held = run(context(), opened.memory, [act('recovery.hold', 'case-1', short)]);
    const asked = run(context(), held.memory, [request('case-1', 'storage', { after: t('18:00'), until: t('19:30') })]);
    const long = offers(asked.posts)[0]!.id;
    const extended = run(context(), asked.memory, [act('recovery.hold', 'case-1', long)]);
    expect(extended.posts).toEqual([]);
    expect(ledger.find(bookingKey('case-1', short))?.status).toBe('released');
    expect(ledger.find(bookingKey('case-1', long))).toMatchObject({ status: 'held', start: t('18:00'), end: t('19:30') });
    expect(run(context(), extended.memory, [request('case-2', 'storage', { after: t('19:00'), until: t('20:00') })]).posts).toEqual([]);
  });

  test('a hold on an expired offer withdraws it; a key the ledger already has is adopted, not fought over', () => {
    const { ledger, context } = fresh();
    const opened = run(context(), emptyTerminalMemory, [request('case-1', 'unload'), request('case-2', 'unload')]);
    const offerId = offers(opened.posts)[0]!.id;
    const late = run(context(t('17:30')), opened.memory, [act('recovery.hold', 'case-1', offerId)]);
    expect(late.posts).toMatchObject([{ kind: 'recovery.withdraw', caseId: 'case-1', offerId, answers: [`offer:case-1:${offerId}`] }]);
    const written = ledger.hold({ key: bookingKey('case-2', offerId), workspaceId: 'w1', caseId: 'case-2', resource: offerId, start: t('18:00'), end: t('19:00'), priceEur: 140, expiresAt: t('17:00'), heldBy: 'cargo' });
    expect(written.ok).toBe(true);
    expect(run(context(), opened.memory, [act('recovery.hold', 'case-2', offerId)]).posts).toEqual([]);
  });
});
