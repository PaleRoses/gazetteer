import { afterEach, describe, expect, test } from 'bun:test';
import { connectParticipant, memoizeByToken, type RelayIdentity } from '../src/server/relay';

const identity = (token: string, extra: Partial<RelayIdentity> = {}): RelayIdentity => ({ token, channel: 'c', ...extra });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('one connection per token', () => {
  test('connects once per token and shares the in-flight attempt between concurrent callers', async () => {
    let connects = 0;
    const connect = memoizeByToken(async (value: RelayIdentity) => { connects += 1; await Promise.resolve(); return { token: value.token }; });
    const [first, second] = await Promise.all([connect(identity('a')), connect(identity('a'))]);
    expect(first).toBe(second);
    expect(await connect(identity('a'))).toBe(first);
    expect(await connect(identity('b'))).not.toBe(first);
    expect(connects).toBe(2);
  });

  test('a failed connection is forgotten so the next call tries again', async () => {
    let attempts = 0;
    const connect = memoizeByToken(async () => { attempts += 1; if (attempts === 1) throw new Error('503'); return 'ok'; });
    await expect(connect(identity('a'))).rejects.toThrow('503');
    expect(await connect(identity('a'))).toBe('ok');
    expect(attempts).toBe(2);
  });
});

describe('building a client from a stored identity', () => {
  const requests: string[] = [];
  const spy = (): void => {
    requests.length = 0;
    globalThis.fetch = (async (input: unknown) => {
      requests.push(String(input));
      return new Response(JSON.stringify({ ok: true, data: { id: 'agent-1', name: 'n', type: 'agent' } }), { status: 200 });
    }) as typeof fetch;
  };

  test('with the agent id and name stored, no request is made', async () => {
    spy();
    const client = await connectParticipant(identity('tok', { agentId: 'agent-1', agentName: 'n' }));
    expect(typeof client.sendMessage).toBe('function');
    expect(requests).toEqual([]);
  });

  test('an identity persisted before ids were stored still connects, by asking the origin once', async () => {
    spy();
    await connectParticipant(identity('tok'));
    expect(requests).toHaveLength(1);
  });
});
