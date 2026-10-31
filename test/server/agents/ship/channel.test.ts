import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../../../src/core/demo';
import { relaySuccess, type Disruption, type RelayOutcome } from '../../../../src/core/types';
import { hear } from '../../../../src/server/agents/ship/channel';
import { think } from '../../../../src/server/agents/ship/think';
import type { ChannelRead } from '../../../../src/server/relay/board';
import { emptyInbox, type Inbox } from '../../../../src/server/relay/inbox';

const now = '2026-10-31T12:00:00.000Z';
const [meridian] = demoShipments(new Date(now));
const disruption: Disruption = { id: 'sg-36', portId: 'singapore', delayHours: 36, evidence: { id: 'sg-36', source: 'simulation', title: 'Berth closure', detail: 'Synthetic.', observedAt: now } };
const delivered: Inbox = { ...emptyInbox, disruptions: [disruption] };
const down: RelayOutcome<ChannelRead> = { status: 'unavailable', message: 'Relay answered 503.' };
const connected: RelayOutcome<null> = relaySuccess(null);

describe('what a ship hears', () => {
  test('Relay history out of reach: the delivered inbox is still heard, the ship stays unsynced and says why', async () => {
    const hearing = await hear({ synced: false, cursor: null }, delivered, connected, async () => down);
    expect(hearing.channel.disruptions).toEqual([disruption]);
    expect(hearing).toMatchObject({ synced: false, unavailable: 'Relay answered 503.' });
  });
  test('no connection at all behaves the same, and never touches the history', async () => {
    let reads = 0;
    const hearing = await hear({ synced: false }, delivered, { status: 'unavailable', message: 'no channel' }, async () => { reads += 1; return down; });
    expect(hearing.channel.disruptions).toEqual([disruption]);
    expect(hearing).toMatchObject({ synced: false, unavailable: 'no channel' });
    expect(reads).toBe(0);
  });
  test('a history that is read joins the inbox and syncs the ship; a synced ship reads no history', async () => {
    const history: ChannelRead = { board: [], disruptions: [{ ...disruption, id: 'older' }], cursor: null };
    const first = await hear({ synced: false }, delivered, connected, async () => relaySuccess(history));
    expect(first.channel.disruptions.map(item => item.id).sort()).toEqual(['older', 'sg-36']);
    expect(first).toMatchObject({ synced: true, unavailable: null });
    let reads = 0;
    const later = await hear({ synced: true }, delivered, connected, async () => { reads += 1; return down; });
    expect(later.channel.disruptions).toEqual([disruption]);
    expect(reads).toBe(0);
  });
  test('Relay returning 503 after setup, a disruption delivered locally is applied on the first cycle', async () => {
    const hearing = await hear({ synced: false }, delivered, connected, async () => down);
    const thought = await think({ assess: { model: null, modelId: 'off', now: () => now }, binding: () => null }, { shipment: meridian! }, hearing.channel, now);
    expect(thought.state.shipment.appliedDisruptions).toContain('sg-36');
    expect(thought.state.shipment.delayHours).toBe(36);
    const ignored = await think({ assess: { model: null, modelId: 'off', now: () => now }, binding: () => null }, { shipment: meridian! }, null, now);
    expect(ignored.state.shipment.appliedDisruptions).toEqual([]);
  });
});
