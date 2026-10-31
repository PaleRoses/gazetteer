import { describe, expect, test } from 'bun:test';
import type { BoardMessage } from '../../../src/core/board';
import type { Disruption } from '../../../src/core/types';
import { createDelivery } from '../../../src/server/runtime/delivery';
import type { Inbox } from '../../../src/server/relay/inbox';

const message = (id: string): BoardMessage => ({
  kind: 'ship.eta', id, author: { role: 'ship', id: 's-1', vessel: 'V' }, at: '2026-10-31T20:00:00.000Z', summary: 's',
  shipmentId: 's-1', portId: 'singapore', eta: '2026-11-03T00:00:00.000Z', previousEta: '2026-11-01T00:00:00.000Z',
} as BoardMessage);
const posts = (...ids: string[]): Inbox => ({ board: ids.map(message), disruptions: [] });
const ids = (batch: Inbox): string[] => batch.board.map(item => item.id);
const idle = (): Promise<void> => new Promise(done => setTimeout(done, 0));
const until = async (condition: () => boolean): Promise<void> => { for (let tries = 0; tries < 200 && !condition(); tries += 1) await idle(); };

/** An actor that accepts what it is sent, merged by id, and refuses the first `failures` sends. */
const actor = (failures = 0) => {
  const sends: string[][] = [];
  const held = new Set<string>();
  let remaining = failures;
  return {
    sends, held,
    send: async (batch: Inbox): Promise<void> => {
      sends.push(ids(batch));
      if (remaining > 0) { remaining -= 1; throw new Error('actor busy'); }
      ids(batch).forEach(id => held.add(id));
    },
  };
};
const instant = { sleep: () => Promise.resolve(), delaysMs: [0] };

describe('delivery watermark', () => {
  test('a send that fails once is retried by itself: with nothing else arriving, the actor still converges, and is then sent nothing more', async () => {
    const delivery = createDelivery(instant);
    const ship = actor(1);
    delivery.record('w', posts('a'));
    await delivery.deliver('w', 'ship-1', ship.send);
    await until(() => ship.held.has('a'));
    expect([...ship.held]).toEqual(['a']);
    expect(ship.sends).toEqual([['a'], ['a']]);
    const settled = ship.sends.length;
    await delivery.deliver('w', 'ship-1', ship.send);
    expect(ship.sends.length).toBe(settled);
  });

  test('the watermark moves only on success: the failed batch is part of the next cumulative send', async () => {
    const delivery = createDelivery({ sleep: () => new Promise(() => undefined), delaysMs: [0] });
    const ship = actor(1);
    delivery.record('w', posts('a'));
    await delivery.deliver('w', 'ship-1', ship.send);
    expect(ship.held.size).toBe(0);
    delivery.record('w', posts('b'));
    await delivery.deliver('w', 'ship-1', ship.send);
    expect(ship.sends).toEqual([['a'], ['a', 'b']]);
    expect([...ship.held]).toEqual(['a', 'b']);
  });

  test('actors are independent: one that keeps failing does not hold back another', async () => {
    const delivery = createDelivery({ sleep: () => new Promise(() => undefined), delaysMs: [0] });
    const broken = actor(1_000);
    const healthy = actor();
    delivery.record('w', posts('a'));
    await Promise.all([delivery.deliver('w', 'broken', broken.send), delivery.deliver('w', 'healthy', healthy.send)]);
    expect([...healthy.held]).toEqual(['a']);
    expect(broken.held.size).toBe(0);
  });

  test('an actor that only wants board posts keeps its mark while it is sent nothing else', async () => {
    const delivery = createDelivery(instant);
    const port = actor();
    const wantsBoard = (batch: Inbox): boolean => batch.board.length > 0;
    delivery.record('w', { board: [], disruptions: [{ id: 'd' } as Disruption] });
    await delivery.deliver('w', 'port', port.send, wantsBoard);
    expect(port.sends).toEqual([]);
    delivery.record('w', posts('a'));
    await delivery.deliver('w', 'port', port.send, wantsBoard);
    expect(port.sends).toEqual([['a']]);
  });

  test('close stops the retries', async () => {
    const delivery = createDelivery(instant);
    const ship = actor(1_000);
    delivery.record('w', posts('a'));
    await delivery.deliver('w', 'ship-1', ship.send);
    delivery.close();
    await idle();
    const frozen = ship.sends.length;
    await idle(); await idle();
    expect(ship.sends.length).toBe(frozen);
  });
});
