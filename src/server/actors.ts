import { Actor, Persisted } from 'durable-actors';
import { ports } from '../domain';
import { relaySuccess, type Disruption, type PortId, type RelayOutcome, type Shipment } from '../shared';
import { assessmentFromEnv, assessNotices, type AssessmentCache } from './assessment';
import { postBoard, readBoard } from './board/transport';
import { emptyMemory, type PortMemory } from './port/memory';
import { watchPort } from './port/watch';
import { pollPort } from './sources';
import { emptyTelemetryState, mmsiPattern, telemetrySourceFromEnv, watchShipment, type TelemetryState } from './telemetry';
import { toDisruption } from './sources/disruption';
import type { Cursor } from './realtime/cursor';
import { attemptRelay, joinChannel, publishDisruption, readDisruptionsSince, registerParticipant, relayChannel, type RelayIdentity } from './relay';

const checkIntervalMs = 60_000;
type PortState = Readonly<{
  portId: PortId; relay: RelayIdentity; ready: boolean;
  outbox: readonly Disruption[]; published: readonly string[]; checkedAt: string | null; board?: PortMemory;
}>;
type ShipmentState = Readonly<{ shipment: Shipment; relay: RelayIdentity; ready: boolean; checkedAt: string | null; assessmentCache?: AssessmentCache; cursor?: Cursor | null; mmsi?: string; telemetry?: TelemetryState }>;
const assessment = assessmentFromEnv(process.env);
const telemetrySource = telemetrySourceFromEnv(process.env);
const enqueueLive = (state: PortState, incoming: readonly Disruption[]): readonly Disruption[] =>
  [...state.outbox, ...incoming.filter(live => !state.outbox.some(event => event.id === live.id) && !state.published.includes(live.id))];
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
    // Provider failures are data inside the sources layer, so a dead feed leaves the outbox untouched.
    const reaching = await pollPort(this.state.portId);
    this.state = { ...this.state, outbox: enqueueLive(this.state, reaching.map(toDisruption)) };
    const current = this.state;
    const connection = await connect(current, current.portId === 'singapore');
    if (connection.status === 'unavailable') return connection;
    const publication = await attemptRelay(() => current.outbox.reduce<Promise<void>>((previous, disruption) => previous.then(async () => { await publishDisruption(current.relay, disruption); }), Promise.resolve()), 'Agent Relay publication is unavailable. The disruption remains queued for retry.');
    if (publication.status === 'unavailable') return publication;
    const committed: PortState = { ...current, ready: true, outbox: [], published: [...current.published, ...current.outbox.map(event => event.id)], checkedAt: new Date().toISOString() };
    this.state = committed;
    // The port's own watching: read what ships posted, assess, and post a bulletin only when something changed.
    const place = ports.find(value => value.id === committed.portId);
    if (!place) return relaySuccess(null);
    const watched = await watchPort({ read: readBoard, post: postBoard }, committed.relay, committed.board ?? emptyMemory,
      { portId: place.id, name: place.name, coordinates: place.coordinates, now: new Date(), notices: reaching });
    this.state = { ...committed, board: watched.memory };
    return watched.outcome;
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

  async initialize(workspaceId: string, shipment: Shipment, workspaceKey: string, mmsi?: string): Promise<RelayOutcome<null>> {
    if (mmsi !== undefined && !mmsiPattern.test(mmsi)) return { status: 'unavailable', message: 'MMSI must be nine digits.' };
    if (mmsi && this.state && this.state.mmsi !== mmsi) this.state = { ...this.state, mmsi };
    if (this.state?.ready) return relaySuccess(null);
    await this.scheduleCheck();
    if (!this.state) {
      const registration = await attemptRelay(() => registerParticipant(workspaceKey, this.id, relayChannel(workspaceId)), 'Agent Relay registration is unavailable. Retry initialization.');
      if (registration.status === 'unavailable') return registration;
      this.state = { shipment, relay: registration.value, ready: false, checkedAt: null, ...(mmsi ? { mmsi } : {}) };
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
    if (this.state.mmsi) {
      const watched = await watchShipment({ source: telemetrySource, assess: assessment }, this.state.shipment, this.state.mmsi, this.state.telemetry ?? emptyTelemetryState, this.state.assessmentCache ?? {});
      this.state = { ...this.state, shipment: watched.shipment, telemetry: watched.state, assessmentCache: watched.cache };
    }
    const current = this.state;
    const connection = await connect(current, false);
    if (connection.status === 'unavailable') return connection;
    const replay = await attemptRelay(() => readDisruptionsSince(current.relay, current.cursor ?? null), 'Agent Relay history is unavailable. Monitoring will retry without changing the shipment.');
    if (replay.status === 'unavailable') return replay;
    const assessed = await assessNotices(assessment, current.assessmentCache ?? {}, current.shipment, replay.value.disruptions);
    this.state = { ...current, ready: true, shipment: assessed.shipment, assessmentCache: assessed.cache, cursor: replay.value.cursor, checkedAt: new Date().toISOString() };
    return relaySuccess(this.state.shipment);
  }

  async onAlarm(): Promise<void> { await this.check(); }
}
