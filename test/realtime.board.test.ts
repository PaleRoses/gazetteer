import { describe, expect, test } from 'bun:test';
import { boardMetadataKind, type BoardMessage } from '../src/board';
import { boardTransport } from '../src/server/board/transport';
import type { RelayIdentity } from '../src/server/relay';

const identity: RelayIdentity = { token: 'at_test', channel: 'gazetteer-w1' };
const bulletin = (id: string, risk: 'normal' | 'severe' = 'severe'): BoardMessage => ({
  kind: 'port.bulletin', id, author: { role: 'port', id: 'singapore' }, at: '2026-10-31T20:00:00.000Z', summary: 'Berth congestion',
  portId: 'singapore', risk, anchored: 3, arrivals48h: 2, evidenceIds: ['e1'],
});
const eta = (id: string): BoardMessage => ({
  kind: 'ship.eta', id, author: { role: 'ship', id: 's-1', vessel: 'Meridian Star' }, at: '2026-10-31T20:01:00.000Z', summary: 'ETA moved +36h',
  shipmentId: 's-1', portId: 'singapore', eta: '2026-11-03T00:00:00.000Z', previousEta: '2026-11-01T12:00:00.000Z',
});

/** In-memory Relay channel with the recorded list/send semantics (newest-first, snowflake ids, idempotency keys). */
const fakeChannel = () => {
  type Stored = { messageId: string; createdAt: string; metadata: Record<string, unknown>; text: string };
  const stored: Stored[] = [];
  const keys = new Map<string, string>();
  const sends: unknown[] = [];
  const client = {
    sendMessage: async (input: { idempotencyKey?: string; metadata?: Record<string, unknown> | null; text?: string }) => {
      sends.push(input);
      const known = input.idempotencyKey ? keys.get(input.idempotencyKey) : undefined;
      if (known) return stored.find(item => item.messageId === known)!;
      const entry = { messageId: String(242_000_000_000_000_000n + BigInt(stored.length + 1) * 1_000_000_000n), createdAt: new Date(Date.UTC(2026, 9, 31, 20, 0, stored.length)).toISOString(), metadata: input.metadata ?? {}, text: input.text ?? '' };
      stored.push(entry);
      if (input.idempotencyKey) keys.set(input.idempotencyKey, entry.messageId);
      return entry;
    },
    messages: {
      list: async (_channel: string, options?: { limit?: number; before?: string; after?: string }) => stored
        .filter(item => (options?.after === undefined || BigInt(item.messageId) > BigInt(options.after)) && (options?.before === undefined || BigInt(item.messageId) < BigInt(options.before)))
        .toReversed().slice(0, options?.limit ?? 100),
    },
  };
  return { client: client as never, raw: client, stored, sends };
};

describe('board transport', () => {
  test('posts with the message id as idempotency key and the agreed metadata, and a retried post adds nothing', async () => {
    const channel = fakeChannel();
    const transport = boardTransport(async () => channel.client);
    const first = await transport.postBoard(identity, bulletin('b-1'));
    const again = await transport.postBoard(identity, bulletin('b-1'));
    expect(first.status).toBe('ok');
    expect(again).toEqual(first);
    expect(channel.stored).toHaveLength(1);
    expect(channel.sends[0]).toMatchObject({ to: '#gazetteer-w1', idempotencyKey: 'b-1', text: 'Berth congestion', metadata: { kind: boardMetadataKind, message: bulletin('b-1') } });
  });

  test('refuses to post a malformed message and says so', async () => {
    const channel = fakeChannel();
    const outcome = await boardTransport(async () => channel.client).postBoard(identity, { ...bulletin('b-2'), risk: 'catastrophic' } as never);
    expect(outcome.status).toBe('unavailable');
    expect(channel.sends).toHaveLength(0);
  });

  test('reads only past the cursor, oldest first, skipping foreign and corrupt messages, and replays to nothing', async () => {
    const channel = fakeChannel();
    const transport = boardTransport(async () => channel.client);
    await transport.postBoard(identity, bulletin('b-1'));
    await channel.raw.sendMessage({ text: 'chatter', metadata: { kind: 'something.else' } });
    await channel.raw.sendMessage({ text: 'corrupt', metadata: { kind: boardMetadataKind, message: { kind: 'port.bulletin' } } });
    await transport.postBoard(identity, eta('e-1'));
    const first = await transport.readBoard(identity, null);
    expect(first.status === 'ok' && first.value.messages.map(message => message.id)).toEqual(['b-1', 'e-1']);
    if (first.status !== 'ok') throw new Error('unreachable');
    await transport.postBoard(identity, bulletin('b-3', 'normal'));
    const second = await transport.readBoard(identity, first.value.cursor);
    expect(second.status === 'ok' && second.value.messages.map(message => message.id)).toEqual(['b-3']);
    if (second.status !== 'ok') throw new Error('unreachable');
    const idle = await transport.readBoard(identity, second.value.cursor);
    expect(idle).toEqual({ status: 'ok', value: { messages: [], cursor: second.value.cursor } });
  });

  test('a provider failure is data and the caller keeps its cursor', async () => {
    const down = boardTransport(async () => { throw new Error('relay down'); });
    expect((await down.readBoard(identity, null)).status).toBe('unavailable');
    expect((await down.postBoard(identity, bulletin('b-1'))).status).toBe('unavailable');
  });

  test('readChannel splits one pass into board posts and disruptions under a single cursor', async () => {
    const channel = fakeChannel();
    const transport = boardTransport(async () => channel.client);
    await transport.postBoard(identity, bulletin('b-1'));
    const disruption = { id: 'd-1', portId: 'singapore', delayHours: 36, evidence: { id: 'd-1', source: 'simulation', title: 't', detail: 'x', observedAt: '2026-10-31T20:00:00.000Z' } };
    await channel.raw.sendMessage({ text: 'x', metadata: { kind: 'gazetteer.simulated-disruption', source: 'simulation', disruption } });
    const read = await transport.readChannel(identity, null);
    expect(read.status === 'ok' && [read.value.board.map(message => message.id), read.value.disruptions.map(item => item.id)]).toEqual([['b-1'], ['d-1']]);
  });
});
