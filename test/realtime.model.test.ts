import { describe, expect, test } from 'bun:test';
import type { BoardMessage } from '../src/board';
import { boardMetadataKind } from '../src/board';
import { boardCapacity, createBoardModel, mergeBoard, recentBoard } from '../src/server/board/model';
import { createHub } from '../src/server/realtime/sse';
import type { ListPage, PageRequest } from '../src/server/realtime/cursor';

const eta = (n: number): BoardMessage => ({
  kind: 'ship.eta', id: `eta-${String(n).padStart(4, '0')}`, author: { role: 'ship', id: 's-1', vessel: 'Meridian Star' },
  at: new Date(Date.UTC(2026, 9, 31, 20, 0, 0) + n * 1000).toISOString(), summary: `ETA ${n}`,
  shipmentId: 's-1', portId: 'singapore', eta: '2026-11-03T00:00:00.000Z', previousEta: '2026-11-01T00:00:00.000Z',
});
const relayMessage = (n: number, board: boolean) => ({
  messageId: String(242_000_000_000_000_000n + BigInt(n) * 1_000_000_000n), createdAt: new Date(Date.UTC(2026, 9, 31, 20, 0, n)).toISOString(),
  metadata: board ? { kind: boardMetadataKind, message: eta(n) } : { kind: 'chatter' },
});

describe('mergeBoard', () => {
  test('is chronological, distinct, capped to the newest and independent of arrival order', () => {
    const all = Array.from({ length: 130 }, (_, n) => eta(n));
    const forward = mergeBoard([], all);
    const scrambled = mergeBoard(all.slice(60).toReversed(), [...all.slice(0, 60), ...all.slice(100)]);
    expect(forward).toHaveLength(boardCapacity);
    expect(forward.at(0)?.id).toBe('eta-0030');
    expect(forward.at(-1)?.id).toBe('eta-0129');
    expect(scrambled).toEqual(forward);
    expect(mergeBoard(forward, forward)).toEqual(forward);
  });
});

describe('recentBoard', () => {
  const channel = (messages: readonly ReturnType<typeof relayMessage>[]): ListPage<never> => (async (request: PageRequest) =>
    messages.filter(message => request.before === undefined || BigInt(message.messageId) < BigInt(request.before)).toReversed().slice(0, request.limit)) as never;

  test('collects the newest board messages through interleaved chatter and stops once it has enough', async () => {
    const messages = Array.from({ length: 600 }, (_, n) => relayMessage(n, n % 3 === 0));
    const board = await recentBoard(channel(messages), 100);
    expect(board).toHaveLength(100);
    expect(board.at(-1)?.id).toBe('eta-0597');
  });
  test('returns everything when the channel holds fewer than the capacity', async () => {
    const board = await recentBoard(channel(Array.from({ length: 7 }, (_, n) => relayMessage(n, true))));
    expect(board.map(message => message.id)).toHaveLength(7);
  });
});

describe('createBoardModel', () => {
  test('ingest reports a change only when the board actually changed', () => {
    const model = createBoardModel(async () => []);
    expect(model.ingest('w', [eta(1)])).toBe(true);
    expect(model.ingest('w', [eta(1)])).toBe(false);
    expect(model.ingest('w', [eta(2)])).toBe(true);
    expect(model.ingest('other', [eta(1)])).toBe(true);
  });
  test('reading never blocks: the board is undefined until the background read lands, which then announces itself and merges with live messages', async () => {
    let release: (messages: readonly BoardMessage[]) => void = () => undefined;
    const announced: string[] = [];
    const model = createBoardModel(() => new Promise(done => { release = done; }), { onHydrated: id => announced.push(id) });
    model.ingest('w', [eta(3)]);
    expect(model.board('w')).toBeUndefined();
    expect(model.board('w')).toBeUndefined();
    release([eta(1), eta(2)]);
    await new Promise(done => setTimeout(done, 5));
    expect(model.board('w')?.map(message => message.id)).toEqual(['eta-0001', 'eta-0002', 'eta-0003']);
    expect(announced).toEqual(['w']);
  });
  test('a failed read is retried only after the cool-down, never in a tight loop, and one read is in flight at a time', async () => {
    let attempts = 0;
    let clock = 0;
    const model = createBoardModel(async () => { attempts += 1; if (attempts === 1) throw new Error('relay down'); return [eta(1)]; }, { retryAfterMs: 1000, now: () => clock });
    model.board('w'); model.board('w');
    await new Promise(done => setTimeout(done, 5));
    expect(attempts).toBe(1);
    clock = 500; model.board('w');
    await new Promise(done => setTimeout(done, 5));
    expect(attempts).toBe(1);
    clock = 1500; model.board('w');
    await new Promise(done => setTimeout(done, 5));
    expect(attempts).toBe(2);
    expect(model.board('w')?.map(message => message.id)).toEqual(['eta-0001']);
  });
});

describe('dashboard push on board change', () => {
  test('a new board message alone makes the hub push a dashboard, a repeat does not', () => {
    const hub = createHub();
    const pushed: unknown[] = [];
    hub.subscribe('w', event => pushed.push(event));
    const dashboard = (board: readonly BoardMessage[]) => ({ shipments: [], ports: [], updatedAt: new Date().toISOString(), mode: 'simulation', runtime: 'r', relay: 'r', board }) as never;
    expect(hub.publishDashboard('w', dashboard([eta(1)]))).toBe(true);
    expect(hub.publishDashboard('w', dashboard([eta(1)]))).toBe(false);
    expect(hub.publishDashboard('w', dashboard([eta(1), eta(2)]))).toBe(true);
    expect(pushed).toHaveLength(2);
  });
});
