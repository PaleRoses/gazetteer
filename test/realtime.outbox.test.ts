import { describe, expect, test } from 'bun:test';
import type { BoardMessage } from '../src/board';
import type { RelayOutcome } from '../src/shared';
import { enqueue, flush } from '../src/server/realtime/outbox';

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
});
