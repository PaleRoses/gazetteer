import { Actor, Persisted } from 'durable-actors';
import { assessDisruption } from '../domain';
import { relaySuccess, type Disruption, type PortId, type RelayOutcome, type Shipment } from '../shared';
import { attemptRelay, joinChannel, publishDisruption, readDisruptions, registerParticipant, relayChannel, type RelayIdentity } from './relay';

const checkIntervalMs = 60_000;
type PortState = Readonly<{
  portId: PortId; relay: RelayIdentity; ready: boolean;
  outbox: readonly Disruption[]; published: readonly string[]; checkedAt: string | null;
}>;
type ShipmentState = Readonly<{ shipment: Shipment; relay: RelayIdentity; ready: boolean; checkedAt: string | null }>;
const connect = (state: Readonly<{ relay: RelayIdentity; ready: boolean }>, createChannel: boolean): Promise<RelayOutcome<null>> =>
  state.ready ? Promise.resolve(relaySuccess(null)) : attemptRelay(async () => {
    await joinChannel(state.relay, createChannel);
    return null;
  }, 'Agent Relay channel is unavailable. Monitoring will retry.');

/** Terse owns serialization, persistence and alarms; domain transitions are pure. */
export class PortAgent extends Actor {
  @Persisted private state: PortState | null = null;
  @Persisted private nextCheckAt: number | null = null;

  /** Terse local's alarm index is memory-only; startup restores the persisted deadline. */
  async resume(): Promise<void> {
    if (!this.state) return;
    this.nextCheckAt = this.nextCheckAt ?? Date.now();
    this.alarm.set(this.nextCheckAt);
  }

  private async scheduleCheck(): Promise<void> {
    this.nextCheckAt = Date.now() + checkIntervalMs;
    this.alarm.set(this.nextCheckAt);
  }

  async initialize(workspaceId: string, portId: PortId, workspaceKey: string, createChannel: boolean): Promise<RelayOutcome<null>> {
    if (this.state?.ready) return relaySuccess(null);
    await this.scheduleCheck();
    if (!this.state) {
      const registration = await attemptRelay(() => registerParticipant(workspaceKey, this.id, relayChannel(workspaceId)), 'Agent Relay registration is unavailable. Retry initialization.');
      if (registration.status === 'unavailable') return registration;
      this.state = { portId, relay: registration.value, ready: false, outbox: [], published: [], checkedAt: null };
    }
    const connection = await connect(this.state, createChannel);
    if (connection.status === 'unavailable') return connection;
    this.state = { ...this.state, ready: true };
    return relaySuccess(null);
  }

  async simulate(disruption: Disruption): Promise<void> {
    if (!this.state || disruption.portId !== this.state.portId) return;
    this.state = this.state.outbox.some(event => event.id === disruption.id) || this.state.published.includes(disruption.id)
      ? this.state : { ...this.state, outbox: [...this.state.outbox, disruption] };
    // Commit the outbox before publishing in a separate invocation.
    await this.scheduleCheck();
  }

  async check(): Promise<RelayOutcome<null>> {
    await this.scheduleCheck();
    if (!this.state) return { status: 'unavailable', message: 'Port monitoring has not been initialized.' };
    const current = this.state;
    const connection = await connect(current, current.portId === 'singapore');
    if (connection.status === 'unavailable') return connection;
    const publication = await attemptRelay(() => current.outbox.reduce<Promise<void>>((previous, disruption) => previous.then(async () => { await publishDisruption(current.relay, disruption); }), Promise.resolve()), 'Agent Relay publication is unavailable. The disruption remains queued for retry.');
    if (publication.status === 'unavailable') return publication;
    this.state = { ...current, ready: true, outbox: [], published: [...current.published, ...current.outbox.map(event => event.id)], checkedAt: new Date().toISOString() };
    return relaySuccess(null);
  }

  async onAlarm(): Promise<void> { await this.check(); }
}

export class ShipmentAgent extends Actor {
  @Persisted private state: ShipmentState | null = null;
  @Persisted private nextCheckAt: number | null = null;

  async resume(): Promise<void> {
    if (!this.state) return;
    this.nextCheckAt = this.nextCheckAt ?? Date.now();
    this.alarm.set(this.nextCheckAt);
  }

  private async scheduleCheck(): Promise<void> {
    this.nextCheckAt = Date.now() + checkIntervalMs;
    this.alarm.set(this.nextCheckAt);
  }

  async initialize(workspaceId: string, shipment: Shipment, workspaceKey: string): Promise<RelayOutcome<null>> {
    if (this.state?.ready) return relaySuccess(null);
    await this.scheduleCheck();
    if (!this.state) {
      const registration = await attemptRelay(() => registerParticipant(workspaceKey, this.id, relayChannel(workspaceId)), 'Agent Relay registration is unavailable. Retry initialization.');
      if (registration.status === 'unavailable') return registration;
      this.state = { shipment, relay: registration.value, ready: false, checkedAt: null };
    }
    const connection = await connect(this.state, false);
    if (connection.status === 'unavailable') return connection;
    this.state = { ...this.state, ready: true };
    return relaySuccess(null);
  }

  async snapshot(): Promise<Shipment | null> { return this.state?.shipment ?? null; }

  async check(): Promise<RelayOutcome<Shipment>> {
    await this.scheduleCheck();
    if (!this.state) return { status: 'unavailable', message: 'Shipment monitoring has not been initialized.' };
    const current = this.state;
    const connection = await connect(current, false);
    if (connection.status === 'unavailable') return connection;
    const replay = await attemptRelay(() => readDisruptions(current.relay), 'Agent Relay history is unavailable. Monitoring will retry without changing the shipment.');
    if (replay.status === 'unavailable') return replay;
    this.state = { ...current, ready: true, shipment: replay.value.reduce(assessDisruption, current.shipment), checkedAt: new Date().toISOString() };
    return relaySuccess(this.state.shipment);
  }

  async onAlarm(): Promise<void> { await this.check(); }
}
