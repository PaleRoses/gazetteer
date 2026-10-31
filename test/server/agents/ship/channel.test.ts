import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../../../src/core/demo';
import type { Disruption } from '../../../../src/core/types';
import { hear } from '../../../../src/server/agents/ship/channel';
import { think } from '../../../../src/server/agents/ship/think';
import type { ChannelRead } from '../../../../src/server/relay/board';
import { emptyInbox, type Inbox } from '../../../../src/server/relay/inbox';

const now = '2026-10-31T12:00:00.000Z';
const [meridian] = demoShipments(new Date(now));
const disruption: Disruption = { id: 'sg-36', portId: 'singapore', delayHours: 36, evidence: { id: 'sg-36', source: 'simulation', title: 'Berth closure', detail: 'Synthetic.', observedAt: now } };
const delivered: Inbox = { ...emptyInbox, disruptions: [disruption] };

describe('what a ship hears', () => {
  test('Relay history not here yet: the delivered inbox is still heard, the ship stays unsynced and says why', () => {
    const hearing = hear({ synced: false, cursor: null }, delivered, null, 'Relay answered 503.');
    expect(hearing.channel.disruptions).toEqual([disruption]);
    expect(hearing).toMatchObject({ synced: false, unavailable: 'Relay answered 503.' });
    expect(hear({ synced: false }, delivered, null, null).unavailable).not.toBeNull();
  });
  test('a history that has arrived joins the inbox and syncs the ship; a synced ship ignores a late history', () => {
    const history: ChannelRead = { board: [], disruptions: [{ ...disruption, id: 'older' }], cursor: null };
    const first = hear({ synced: false }, delivered, history, null);
    expect(first.channel.disruptions.map(item => item.id).sort()).toEqual(['older', 'sg-36']);
    expect(first).toMatchObject({ synced: true, unavailable: null });
    expect(hear({ synced: true }, delivered, history, null).channel.disruptions).toEqual([disruption]);
  });
  test('Relay returning 503 after setup, a disruption delivered locally is applied on the first cycle', async () => {
    const hearing = hear({ synced: false }, delivered, null, 'Relay answered 503.');
    const thought = await think({ assess: { model: null, modelId: 'off', now: () => now }, binding: () => null }, { shipment: meridian! }, hearing.channel, now);
    expect(thought.state.shipment.appliedDisruptions).toContain('sg-36');
    expect(thought.state.shipment.delayHours).toBe(36);
    const ignored = await think({ assess: { model: null, modelId: 'off', now: () => now }, binding: () => null }, { shipment: meridian! }, null, now);
    expect(ignored.state.shipment.appliedDisruptions).toEqual([]);
  });
});
