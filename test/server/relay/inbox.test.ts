import { describe, expect, test } from 'bun:test';
import type { BoardMessage } from '../../../src/core/board';
import type { Disruption } from '../../../src/core/types';
import { drainInbox, emptyInbox, inboxCapacity, mergeInbox } from '../../../src/server/relay/inbox';

const eta = (id: string): BoardMessage => ({
  kind: 'ship.eta', id, author: { role: 'ship', id: 's-1', vessel: 'V' }, at: '2026-10-31T20:00:00.000Z', summary: 's',
  shipmentId: 's-1', portId: 'singapore', eta: '2026-11-03T00:00:00.000Z', previousEta: '2026-11-01T00:00:00.000Z',
});
const disruption = (id: string): Disruption => ({ id, portId: 'singapore', delayHours: 12, evidence: { id, source: 'simulation', title: 't', detail: 'd', observedAt: '2026-10-31T20:00:00.000Z' } });

describe('inbox', () => {
  test('the Relay copy of an echoed message is a no-op, so local echo and the stream never double-apply', () => {
    const echoed = mergeInbox(undefined, { board: [eta('a')], disruptions: [disruption('d1')] });
    const relayed = mergeInbox(echoed, { board: [eta('a')], disruptions: [disruption('d1')] });
    expect(relayed).toEqual(echoed);
  });
  test('arrival order is kept and the newest messages survive the cap', () => {
    const many = Array.from({ length: inboxCapacity + 20 }, (_, index) => eta(`m${index}`));
    const merged = mergeInbox(emptyInbox, { board: many, disruptions: [] });
    expect(merged.board).toHaveLength(inboxCapacity);
    expect(merged.board.at(0)?.id).toBe('m20');
    expect(merged.board.at(-1)?.id).toBe(`m${inboxCapacity + 19}`);
  });
  test('draining removes what was processed but keeps what arrived while the actor was busy', () => {
    const during = mergeInbox({ board: [eta('a'), eta('b')], disruptions: [disruption('d1')] }, { board: [eta('late')], disruptions: [] });
    const after = drainInbox(during, { board: [eta('a'), eta('b')], disruptions: [disruption('d1')] });
    expect(after).toEqual({ board: [eta('late')], disruptions: [] });
  });
});
