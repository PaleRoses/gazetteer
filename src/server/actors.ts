import { Actor, Persisted } from 'durable-actors';
import { assessDisruption } from '../domain';
import type { Disruption, PortId, Shipment } from '../shared';
import { joinChannel, publishDisruption, readDisruptions, registerParticipant, relayChannel, type RelayIdentity } from './relay';

const checkIntervalMs = 60_000;
type PortState = Readonly<{
  portId: PortId; relay: RelayIdentity; ready: boolean;
  outbox: readonly Disruption[]; published: readonly string[]; checkedAt: string | null;
}>;
type ShipmentState = Readonly<{ shipment: Shipment; relay: RelayIdentity; ready: boolean; checkedAt: string | null }>;

/** Terse owns serialization, persistence and alarms; domain transitions are pure. */
export class PortAgent extends Actor {
  @Persisted private state: PortState | null = null;

  async initialize(workspaceId: string, portId: PortId, workspaceKey: string, createChannel: boolean): Promise<void> {
    if (this.state?.ready) return;
    const relay = this.state?.relay ?? await registerParticipant(workspaceKey, this.id, relayChannel(workspaceId));
    this.state = this.state ?? { portId, relay, ready: false, outbox: [], published: [], checkedAt: null };
    await joinChannel(relay, createChannel);
    this.state = { ...this.state, ready: true };
    this.alarm.set(Date.now() + checkIntervalMs);
  }

  async simulate(disruption: Disruption): Promise<void> {
    if (!this.state || disruption.portId !== this.state.portId) return;
    this.state = this.state.outbox.some(event => event.id === disruption.id) || this.state.published.includes(disruption.id)
      ? this.state : { ...this.state, outbox: [...this.state.outbox, disruption] };
    await this.check();
  }

  async check(): Promise<void> {
    this.alarm.set(Date.now() + checkIntervalMs);
    if (!this.state) return;
    const current = this.state;
    await Promise.all(current.outbox.map(disruption => publishDisruption(current.relay, disruption)));
    this.state = { ...current, outbox: [], published: [...current.published, ...current.outbox.map(event => event.id)], checkedAt: new Date().toISOString() };
  }

  async onAlarm(): Promise<void> { await this.check(); }
}

export class ShipmentAgent extends Actor {
  @Persisted private state: ShipmentState | null = null;

  async initialize(workspaceId: string, shipment: Shipment, workspaceKey: string): Promise<void> {
    if (this.state?.ready) return;
    const relay = this.state?.relay ?? await registerParticipant(workspaceKey, this.id, relayChannel(workspaceId));
    this.state = this.state ?? { shipment, relay, ready: false, checkedAt: null };
    await joinChannel(relay, false);
    this.state = { ...this.state, ready: true };
    this.alarm.set(Date.now() + checkIntervalMs);
  }

  async snapshot(): Promise<Shipment | null> { return this.state?.shipment ?? null; }

  async check(): Promise<Shipment | null> {
    this.alarm.set(Date.now() + checkIntervalMs);
    if (!this.state) return null;
    const current = this.state;
    const disruptions = await readDisruptions(current.relay);
    this.state = { ...current, shipment: disruptions.reduce(assessDisruption, current.shipment), checkedAt: new Date().toISOString() };
    return this.state.shipment;
  }

  async onAlarm(): Promise<void> { await this.check(); }
}
