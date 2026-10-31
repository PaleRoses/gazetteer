import { describe, expect, test } from 'bun:test';
import type { Disruption } from '../../../../src/core/types';
import { accept, adopt, delivered, emptyQueue, waiting } from '../../../../src/server/agents/port/outbox';

const disruption = (id: string): Disruption => ({
  id, portId: 'singapore', delayHours: 6,
  evidence: { id, source: 'simulation', title: 't', detail: 'd', observedAt: '2026-10-31T20:00:00.000Z' },
});
const roundTrip = <A>(value: A): A => JSON.parse(JSON.stringify(value)) as A;

describe('a port queue that needs no Relay', () => {
  test('a disruption accepted before registration is held, once, and survives serialisation', () => {
    const held = accept(accept(emptyQueue, disruption('a'), false), disruption('a'), false);
    expect(held.pending.map(item => item.id)).toEqual(['a']);
    expect(roundTrip(held)).toEqual(held);
  });

  test('registration adopts it in arrival order, and a repeat after adoption is still one', () => {
    const arrived = ['a', 'b', 'c'].reduce((queue, id) => accept(queue, disruption(id), false), emptyQueue);
    const adopted = adopt(arrived);
    expect(adopted.pending).toEqual([]);
    expect(adopted.outbox.map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(accept(adopted, disruption('b'), true)).toBe(adopted);
    expect(adopt(adopted)).toEqual(adopted);
  });

  test('exactly once: published ids are never queued again, whichever side of registration the repeat arrives', () => {
    const queued = adopt(accept(emptyQueue, disruption('a'), false));
    const sent = delivered(queued, queued.outbox);
    expect(sent.outbox).toEqual([]);
    expect(sent.published).toEqual(['a']);
    expect(accept(sent, disruption('a'), true)).toBe(sent);
    expect(accept(sent, disruption('a'), false)).toBe(sent);
    expect(delivered(sent, queued.outbox).published).toEqual(['a']);
  });

  test('a disruption accepted after registration goes straight to the outbox, and pending never re-adopts a published id', () => {
    const live = accept(emptyQueue, disruption('x'), true);
    expect(live.outbox.map(item => item.id)).toEqual(['x']);
    const stale = { ...emptyQueue, pending: [disruption('p')], published: ['p'] };
    expect(adopt(stale).outbox).toEqual([]);
  });

  test('waiting counts what has not reached Relay', () => {
    const queue = accept(accept(emptyQueue, disruption('a'), false), disruption('b'), true);
    expect(waiting(queue)).toBe(2);
    expect(waiting(delivered(adopt(queue), queue.outbox))).toBe(1);
  });
});
