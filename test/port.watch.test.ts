import { describe, expect, test } from 'bun:test';
import type { BoardMessage, PortBulletin, ShipObservation } from '../src/board';
import { ports } from '../src/domain';
import { emptyMemory } from '../src/server/port/memory';
import { watchPort, type BoardIo } from '../src/server/port/watch';
import type { RelayCursor } from '../src/server/board/transport';
import type { RelayIdentity } from '../src/server/relay';
import type { RelayOutcome } from '../src/shared';

const now = new Date('2026-10-31T20:00:00.000Z');
const identity: RelayIdentity = { token: 't', channel: 'c' };
const rotterdam = ports.find(port => port.id === 'rotterdam')!;
const watch = { portId: 'rotterdam' as const, name: rotterdam.name, coordinates: rotterdam.coordinates, now, notices: [] };
const stopped = (shipmentId: string, signals: ShipObservation['signals'] = ['stationary-outside-port'], observedAt = '2026-10-31T18:00:00.000Z'): ShipObservation => ({
  id: `${shipmentId}:${observedAt}`, kind: 'ship.observation', author: { role: 'ship', id: shipmentId, vessel: shipmentId }, at: observedAt, summary: 'stopped',
  shipmentId, signals, position: [rotterdam.coordinates[0], rotterdam.coordinates[1] + 0.2], nearPort: 'rotterdam', provider: 'test', observedAt,
});

type Script = { reads: (RelayOutcome<{ messages: readonly BoardMessage[]; cursor: RelayCursor }>)[]; posts: (RelayOutcome<string>)[] };
const fake = (script: Script) => {
  const posted: BoardMessage[] = [];
  const cursors: RelayCursor[] = [];
  const io: BoardIo = {
    read: async (_identity, cursor) => { cursors.push(cursor); return script.reads.shift() ?? { status: 'ok', value: { messages: [], cursor } }; },
    post: async (_identity, message) => { posted.push(message); return script.posts.shift() ?? { status: 'ok', value: `relay-${message.id}` }; },
  };
  return { io, posted, cursors };
};
const read = (messages: readonly BoardMessage[], messageId: string): RelayOutcome<{ messages: readonly BoardMessage[]; cursor: RelayCursor }> =>
  ({ status: 'ok', value: { messages, cursor: { messageId, createdAt: null } } });

describe('a port agent alarm', () => {
  test('reads the ships\' observations, posts one bulletin, and stays silent while nothing changes', async () => {
    const { io, posted } = fake({ reads: [read([stopped('a'), stopped('b')], 'm1')], posts: [] });
    const first = await watchPort(io, identity, emptyMemory, watch);
    expect(first.outcome).toEqual({ status: 'ok', value: null });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: 'port.bulletin', id: 'bulletin:rotterdam#1', risk: 'elevated', anchored: 2 });
    expect(first.memory.cursor).toEqual({ messageId: 'm1', createdAt: null });
    const second = await watchPort(io, identity, first.memory, watch);
    expect(second.outcome.status).toBe('ok');
    expect(posted).toHaveLength(1);
  });

  test('a change in count posts the next bulletin; a ship moving on is a change', async () => {
    const { io, posted } = fake({ reads: [read([stopped('a'), stopped('b')], 'm1'), read([stopped('b', ['slow-steaming'], '2026-10-31T19:00:00.000Z')], 'm2')], posts: [] });
    const first = await watchPort(io, identity, emptyMemory, watch);
    const second = await watchPort(io, identity, first.memory, watch);
    expect(posted.map(message => message.id)).toEqual(['bulletin:rotterdam#1', 'bulletin:rotterdam#2']);
    expect(posted[1]).toMatchObject({ anchored: 1, risk: 'elevated' });
    expect(second.memory.bulletin?.id).toBe('bulletin:rotterdam#2');
  });

  test('an unreadable board changes nothing and posts nothing', async () => {
    const { io, posted } = fake({ reads: [{ status: 'unavailable', message: 'down' }], posts: [] });
    const result = await watchPort(io, identity, emptyMemory, watch);
    expect(result.outcome).toEqual({ status: 'unavailable', message: 'down' });
    expect(result.memory).toBe(emptyMemory);
    expect(posted).toEqual([]);
  });

  test('a failed post is reported, and the retry carries the same id', async () => {
    const { io, posted } = fake({ reads: [read([stopped('a'), stopped('b')], 'm1')], posts: [{ status: 'unavailable', message: 'relay down' }] });
    const failed = await watchPort(io, identity, emptyMemory, watch);
    expect(failed.outcome).toEqual({ status: 'unavailable', message: 'relay down' });
    expect(failed.memory.bulletin).toBeNull();
    expect(failed.memory.observations).toHaveLength(2);
    const retried = await watchPort(io, identity, failed.memory, watch);
    expect(retried.outcome.status).toBe('ok');
    expect(posted.map(message => message.id)).toEqual(['bulletin:rotterdam#1', 'bulletin:rotterdam#1']);
    expect(retried.memory.bulletin?.id).toBe('bulletin:rotterdam#1');
  });

  test('a restarted agent with empty memory resumes the sequence from its own earlier bulletin on the board', async () => {
    const earlier: PortBulletin = { id: 'bulletin:rotterdam#3', kind: 'port.bulletin', author: { role: 'port', id: 'rotterdam' }, at: '2026-10-31T10:00:00.000Z', summary: 'quiet', portId: 'rotterdam', risk: 'normal', anchored: 0, arrivals48h: 0, evidenceIds: [] };
    const { io, posted } = fake({ reads: [read([earlier, stopped('a'), stopped('b')], 'm9')], posts: [] });
    await watchPort(io, identity, emptyMemory, watch);
    expect(posted[0]?.id).toBe('bulletin:rotterdam#4');
  });

  test('another port\'s bulletin and ETA are not this port\'s', async () => {
    const elsewhere: PortBulletin = { id: 'bulletin:singapore#7', kind: 'port.bulletin', author: { role: 'port', id: 'singapore' }, at: now.toISOString(), summary: 'x', portId: 'singapore', risk: 'severe', anchored: 9, arrivals48h: 9, evidenceIds: [] };
    const { io, posted } = fake({ reads: [read([elsewhere], 'm1')], posts: [] });
    const result = await watchPort(io, identity, emptyMemory, watch);
    expect(result.memory.bulletin).toBeNull();
    expect(posted).toEqual([]);
  });
});
