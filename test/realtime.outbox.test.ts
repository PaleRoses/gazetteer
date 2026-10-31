import { describe, expect, test } from 'bun:test';
import type { BoardMessage } from '../src/board';
import type { RelayOutcome } from '../src/shared';
import { enqueue, flush, transmit, without } from '../src/server/realtime/outbox';

const eta = (id: string): BoardMessage => ({
  kind: 'ship.eta', id, author: { role: 'ship', id: 's-1', vessel: 'V' }, at: '2026-10-31T20:00:00.000Z', summary: 's',
  shipmentId: 's-1', portId: 'singapore', eta: '2026-11-03T00:00:00.000Z', previousEta: '2026-11-01T00:00:00.000Z',
});
const ok = (id: string): RelayOutcome<string> => ({ status: 'ok', value: id });

describe('outbox', () => {
  test('a decision made twice is one message, in its first position', () => {
    expect(enqueue([eta('a'), eta('b')], [eta('b'), eta('c')]).map(message => message.id)).toEqual(['a', 'b', 'c']);
  });

  test('a failure keeps the failed message and everything after it; the retry resumes there and never reposts what was acknowledged', async () => {
    const posted: string[] = [];
    let failNext = true;
    const flaky = async (message: BoardMessage): Promise<RelayOutcome<string>> => {
      if (message.id === 'b' && failNext) { failNext = false; return { status: 'unavailable', message: 'relay down' }; }
      posted.push(message.id);
      return ok(message.id);
    };
    const first = await flush(flaky, [eta('a'), eta('b'), eta('c')]);
    expect(first.failure).toBe('relay down');
    expect(first.remaining.map(message => message.id)).toEqual(['b', 'c']);
    expect(posted).toEqual(['a']);
    const second = await flush(flaky, first.remaining);
    expect(second).toEqual({ remaining: [], failure: null });
    expect(posted).toEqual(['a', 'b', 'c']);
  });

  test('a throwing post is data, not a crash, and nothing is lost', async () => {
    const result = await flush(async () => { throw new Error('socket'); }, [eta('a')]);
    expect(result.failure).toBe('socket');
    expect(result.remaining.map(message => message.id)).toEqual(['a']);
  });

  test('an empty outbox posts nothing', async () => {
    let calls = 0;
    await flush(async message => { calls += 1; return ok(message.id); }, []);
    expect(calls).toBe(0);
  });

  test('disruptions go before board posts; a failed disruption holds the board back and only what Relay acknowledged is reported sent', async () => {
    const order: string[] = [];
    const relay = { token: 't', channel: 'c' };
    const effects = (failing: string | null) => ({
      post: async (message: BoardMessage) => { order.push(`b:${message.id}`); return ok(message.id); },
      publish: async (disruption: { id: string }): Promise<RelayOutcome<unknown>> => { order.push(`d:${disruption.id}`); return disruption.id === failing ? { status: 'unavailable', message: 'down' } : ok(disruption.id); },
    });
    const outgoing = { relay, board: [eta('a')], disruptions: [{ id: 'x' }, { id: 'y' }] };
    expect(await transmit(outgoing, effects(null))).toEqual({ board: ['a'], disruptions: ['x', 'y'], failure: null });
    expect(order).toEqual(['d:x', 'd:y', 'b:a']);
    order.length = 0;
    expect(await transmit(outgoing, effects('y'))).toEqual({ board: [], disruptions: ['x'], failure: 'down' });
    expect(order).toEqual(['d:x', 'd:y']);
  });

  test('without removes exactly the acknowledged ids', () => {
    expect(without([{ id: 'a' }, { id: 'b' }, { id: 'c' }], ['b']).map(item => item.id)).toEqual(['a', 'c']);
  });
});
