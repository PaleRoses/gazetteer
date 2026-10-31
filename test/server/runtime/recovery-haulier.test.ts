import { describe, expect, test } from 'bun:test';
import { relaySuccess } from '../../../src/core/types';
import { haulierCities, haulierKey, haulierName, haulierStub, initializeHaulier, withdrawLastTruck, type HaulierClient } from '../../../src/server/runtime/recovery-haulier';

const anchor = '2026-10-31T10:00:00.000Z';

describe('the haulier wiring', () => {
  test('only Rotterdam has a haulier, named beside the city\'s watches', () => {
    expect(haulierCities(anchor)).toEqual(['rotterdam']);
    expect(haulierName('w1', 'rotterdam')).toBe('w1-city-rotterdam-haulier');
    expect(haulierKey('rotterdam')).toBe('haulier:rotterdam');
  });

  test('initialization hands the actor the world\'s trucks counted from the anchor, and the ledger path', async () => {
    const calls: unknown[][] = [];
    const client: Pick<HaulierClient, 'initialize'> = { initialize: async (...args) => { calls.push(args); return relaySuccess(null); } };
    await initializeHaulier(client, { workspaceId: 'w1', city: 'rotterdam', workspaceKey: 'key', createChannel: false, bookingsPath: '/data/bookings.sqlite', anchor });
    expect(calls).toHaveLength(1);
    const [workspaceId, city, , createChannel, bookingsPath, trucks] = calls[0]!;
    expect([workspaceId, city, createChannel, bookingsPath]).toEqual(['w1', 'rotterdam', false, '/data/bookings.sqlite']);
    expect(trucks).toMatchObject([
      { id: 'truck-1700', departs: '2026-10-31T17:00:00.000Z', priceEur: 640 },
      { id: 'truck-1930', departs: '2026-10-31T19:30:00.000Z', priceEur: 720 },
      { id: 'truck-2100', departs: '2026-10-31T21:00:00.000Z', priceEur: 760 },
    ]);
  });

  test('the withdraw control asks for the last truck and says it is simulated', async () => {
    const asked: unknown[][] = [];
    const client: Pick<HaulierClient, 'withdraw'> = { withdraw: async (...args) => { asked.push(args); return relaySuccess('rotterdam:truck:truck-1930'); } };
    expect(await withdrawLastTruck(client)).toEqual(relaySuccess('rotterdam:truck:truck-1930'));
    expect(asked).toEqual([['Simulated: the truck was withdrawn by the demo control.', null]]);
  });

  test('the stub reaches the HaulierAgent actor by its name, with each method it needs', async () => {
    const invoked: unknown[][] = [];
    const stub = haulierStub('w1', 'rotterdam', { invoke: async (...args) => { invoked.push(args); return relaySuccess(null); } });
    await stub.withdraw('r', 'offer');
    await stub.acknowledge({ board: ['m1'], disruptions: [] });
    await stub.unpublished();
    expect(invoked).toEqual([
      ['HaulierAgent', 'w1-city-rotterdam-haulier', 'withdraw', ['r', 'offer']],
      ['HaulierAgent', 'w1-city-rotterdam-haulier', 'acknowledge', [{ board: ['m1'], disruptions: [] }]],
      ['HaulierAgent', 'w1-city-rotterdam-haulier', 'unpublished', []],
    ]);
  });
});
