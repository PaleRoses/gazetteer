import { Actor, Persisted } from 'durable-actors';
import { ports } from '../domain';
import { relaySuccess, type Disruption, type PortId, type RelayOutcome, type Shipment } from '../shared';
import { assessmentFromEnv, assessNotices, type AssessmentCache } from './assessment';
import { postBoard, readBoard, readChannel, type ChannelRead } from './board/transport';
import { emptyMemory, type PortMemory } from './port/memory';
import { watchPort, type BoardIo } from './port/watch';
import { pollPort } from './sources';
import type { BoardMessage } from '../board';
import { decideBoard, emptyBoardMemory, emptyTelemetryState, mmsiPattern, postDecisions, rememberBoard, selectBoardEvidence, telemetrySourceFromEnv, watchShipment, type ShipBoardMemory, type TelemetryState } from './telemetry';
import { toDisruption } from './sources/disruption';
import { demoEnabled, telemetryBinding } from './telemetry/simulation';
import type { Cursor } from './realtime/cursor';
import { drainInbox, emptyInbox, mergeInbox, type Inbox } from './realtime/inbox';
import { attemptRelay, joinChannel, publishDisruption, readDisruptionsSince, registerParticipant, relayChannel, type RelayIdentity } from './relay';

const checkIntervalMs = 60_000;
type PortState = Readonly<{
  portId: PortId; relay: RelayIdentity; ready: boolean;
  outbox: readonly Disruption[]; published: readonly string[]; checkedAt: string | null; board?: PortMemory;
  /** Heard by the server on the Relay stream; `synced` = the actor has read Relay once since it started, so it may live on the inbox alone. */
  inbox?: Inbox; synced?: boolean;
}>;
type ShipmentState = Readonly<{ shipment: Shipment; relay: RelayIdentity; ready: boolean; checkedAt: string | null; assessmentCache?: AssessmentCache; cursor?: Cursor | null; mmsi?: string; telemetry?: TelemetryState; board?: ShipBoardMemory; seen?: readonly BoardMessage[]; inbox?: Inbox; synced?: boolean }>;
const assessment = assessmentFromEnv(process.env);
const telemetrySource = telemetrySourceFromEnv(process.env);
const demo = demoEnabled(process.env);
const enqueueLive = (state: PortState, incoming: readonly Disruption[]): readonly Disruption[] =>
  [...state.outbox, ...incoming.filter(live => !state.outbox.some(event => event.id === live.id) && !state.published.includes(live.id))];
/** A read plus whatever the server already handed over: local echoes may not have reached Relay yet. */
const unionHeard = (read: RelayOutcome<ChannelRead>, heard: Inbox): RelayOutcome<ChannelRead> => read.status === 'unavailable' ? read : relaySuccess({
  ...read.value,
  board: [...new Map([...read.value.board, ...heard.board].map(message => [message.id, message] as const)).values()],
  disruptions: [...new Map([...read.value.disruptions, ...heard.disruptions].map(item => [item.id, item] as const)).values()],
});
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
    this.state = { ...this.state, synced: false };
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

  /** The server heard these on the Relay stream: take them locally instead of reading Relay. */
  async deliver(batch: Inbox): Promise<void> {
    if (this.state) this.state = { ...this.state, inbox: mergeInbox(this.state.inbox, { board: batch.board, disruptions: [] }) };
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
    const heard = committed.inbox?.board ?? [];
    let consumed = false;
    const read: BoardIo['read'] = async (identity, cursor) => {
      if (committed.synced) { consumed = true; return relaySuccess({ messages: heard, cursor }); }
      const result = await readBoard(identity, cursor);
      if (result.status === 'unavailable') return result;
      consumed = true;
      return relaySuccess({ messages: [...new Map([...result.value.messages, ...heard].map(message => [message.id, message] as const)).values()], cursor: result.value.cursor });
    };
    const watched = await watchPort({ read, post: postBoard }, committed.relay, committed.board ?? emptyMemory,
      { portId: place.id, name: place.name, coordinates: place.coordinates, now: new Date(), notices: reaching });
    const latest = this.state ?? committed;
    this.state = { ...latest, board: watched.memory, ...(consumed ? { synced: true, inbox: drainInbox(latest.inbox, { board: heard, disruptions: [] }) } : {}) };
    return watched.outcome;
  }

  async onAlarm(): Promise<void> { await this.check(); }
}

export class ShipmentAgent extends Actor {
  @Persisted private state: ShipmentState | null = null;
  @Persisted private nextCheckAt: number | null = null;

  async resume(): Promise<void> {
    if (!this.state) return;
    this.state = { ...this.state, synced: false };
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

  /** The server heard these on the Relay stream (or authored them): take them locally instead of reading Relay. */
  async deliver(batch: Inbox): Promise<void> {
    if (this.state) this.state = { ...this.state, inbox: mergeInbox(this.state.inbox, batch) };
  }

  async check(): Promise<RelayOutcome<Shipment>> {
    await this.scheduleCheck();
    if (!this.state) return { status: 'unavailable', message: 'Shipment monitoring has not been initialized.' };
    const start = this.state;
    const now = new Date().toISOString();
    const connection = await connect(start, false);
    const heard = start.inbox ?? emptyInbox;
    const channel: RelayOutcome<ChannelRead> = start.synced
      ? relaySuccess({ board: heard.board, disruptions: heard.disruptions, cursor: start.cursor ?? null })
      : connection.status === 'unavailable' ? connection : unionHeard(await readChannel(start.relay, start.cursor ?? null), heard);
    const seen = channel.status === 'ok' ? rememberBoard(start.seen ?? [], channel.value.board, now) : start.seen ?? [];
    const evidence = selectBoardEvidence(start.shipment, seen, now);
    const binding = telemetryBinding(start.shipment, start.mmsi, demo, telemetrySource);
    const watched = binding
      ? await watchShipment({ source: binding.source, assess: assessment, board: evidence }, start.shipment, binding.key, start.telemetry ?? emptyTelemetryState, start.assessmentCache ?? {})
      : { shipment: start.shipment, state: start.telemetry, cache: start.assessmentCache ?? {} };
    if (channel.status === 'unavailable') {
      this.state = { ...start, shipment: watched.shipment, assessmentCache: watched.cache, telemetry: watched.state, seen };
      return channel;
    }
    const assessed = await assessNotices(assessment, watched.cache, watched.shipment, channel.value.disruptions, evidence);
    const posted = await postDecisions(message => postBoard(start.relay, message), start.board ?? emptyBoardMemory, decideBoard(start.board ?? emptyBoardMemory, { shipment: assessed.shipment, situation: watched.state?.situation ?? null, now }));
    this.state = { ...start, ready: true, shipment: assessed.shipment, assessmentCache: assessed.cache, cursor: channel.value.cursor, telemetry: watched.state, board: posted.memory, seen, checkedAt: now, synced: true, inbox: drainInbox(this.state?.inbox, heard) };
    return posted.failure ? { status: 'unavailable', message: posted.failure } : relaySuccess(this.state.shipment);
  }

  async onAlarm(): Promise<void> { await this.check(); }
}
