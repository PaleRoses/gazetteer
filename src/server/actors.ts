import { Actor, Persisted } from 'durable-actors';
import { ports } from '../domain';
import { relaySuccess, type Disruption, type PortId, type RelayOutcome, type Shipment } from '../shared';
import { assessmentFromEnv, assessNotices, type AssessmentCache } from './assessment';
import { postBoard, readBoard, readChannel, type ChannelRead } from './board/transport';
import { emptyMemory, type PortMemory } from './port/memory';
import { watchPort, type BoardIo } from './port/watch';
import { accept, adopt, waiting } from './agents/port/outbox';
import { pollPort } from './sources';
import type { BoardMessage } from '../board';
import { commitDecisions, decideBoard, emptyBoardMemory, emptyTelemetryState, mmsiPattern, rememberBoard, selectBoardEvidence, telemetrySourceFromEnv, watchShipment, type ShipBoardMemory, type TelemetryState } from './telemetry';
import { toDisruption } from './sources/disruption';
import { demoEnabled, telemetryBinding } from './telemetry/simulation';
import type { Cursor } from './realtime/cursor';
import { drainInbox, emptyInbox, mergeInbox, type Inbox } from './realtime/inbox';
import { enqueue, transmit, without, type Outgoing } from './realtime/outbox';
import { attemptRelay, joinChannel, publishDisruption, readDisruptionsSince, registerParticipant, relayChannel, type RelayIdentity } from './relay';

const checkIntervalMs = 60_000;
type PortState = Readonly<{
  portId: PortId; relay: RelayIdentity; ready: boolean;
  outbox: readonly Disruption[]; published: readonly string[]; checkedAt: string | null; board?: PortMemory;
  /** Heard by the server on the Relay stream; `synced` = the actor has read Relay once since it started, so it may live on the inbox alone. */
  inbox?: Inbox; synced?: boolean;
  /** Decided but not yet acknowledged by Relay: durable, retried in order, and visible to the server at once through unpublished(). */
  boardOutbox?: readonly BoardMessage[];
}>;
type ShipmentState = Readonly<{ shipment: Shipment; relay: RelayIdentity; ready: boolean; checkedAt: string | null; assessmentCache?: AssessmentCache; cursor?: Cursor | null; mmsi?: string; telemetry?: TelemetryState; board?: ShipBoardMemory; seen?: readonly BoardMessage[]; inbox?: Inbox; synced?: boolean; boardOutbox?: readonly BoardMessage[] }>;
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
/** Registered: what waited for Relay joins the outbox, and nothing is left waiting. */
const adoptAwaiting = (state: PortState, awaiting: readonly Disruption[] | null): PortState =>
  ({ ...state, outbox: adopt({ pending: awaiting ?? [], outbox: state.outbox, published: state.published }).outbox });
const connect = (state: Readonly<{ relay: RelayIdentity; ready: boolean }>, createChannel: boolean): Promise<RelayOutcome<null>> =>
  state.ready ? Promise.resolve(relaySuccess(null)) : attemptRelay(async () => {
    await joinChannel(state.relay, createChannel);
    return null;
  }, 'Agent Relay channel is unavailable. Monitoring will retry.');

/** Terse owns serialization, persistence and alarms; domain transitions are pure. */
export class PortAgent extends Actor {
  @Persisted private state: PortState | null = null;
  @Persisted private nextCheckAt: number | null = null;
  /** Simulated disruptions accepted before this actor was registered with Relay: local, persisted, adopted into the outbox on registration. */
  @Persisted private awaiting: readonly Disruption[] | null = null;

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
    this.state = adoptAwaiting(this.state, this.awaiting);
    this.awaiting = [];
    const connection = await connect(this.state, createChannel);
    if (connection.status === 'unavailable') return connection;
    this.state = { ...this.state, ready: true };
    return relaySuccess(null);
  }

  /** The server heard these on the Relay stream: take them locally instead of reading Relay. */
  async deliver(batch: Inbox): Promise<void> {
    if (this.state) this.state = { ...this.state, inbox: mergeInbox(this.state.inbox, { board: batch.board, disruptions: [] }) };
  }

  /** Durable from the moment it is accepted: before registration it waits in `pending`, with no Relay needed. */
  async simulate(disruption: Disruption): Promise<void> {
    if (this.state ? disruption.portId !== this.state.portId : !this.id.endsWith(`-port-${disruption.portId}`)) return;
    const queue = accept({ pending: this.awaiting ?? [], outbox: this.state?.outbox ?? [], published: this.state?.published ?? [] }, disruption, this.state !== null);
    this.awaiting = queue.pending;
    if (!this.state) return;
    this.state = { ...this.state, outbox: queue.outbox };
    // Commit the outbox before publishing in a separate invocation.
    await this.scheduleCheck();
  }

  /** Disruptions accepted but not yet on Relay. */
  async queued(): Promise<number> {
    return waiting({ pending: this.awaiting ?? [], outbox: this.state?.outbox ?? [], published: [] });
  }

  async check(): Promise<RelayOutcome<null>> {
    await this.scheduleCheck();
    if (!this.state) return { status: 'unavailable', message: 'Port monitoring has not been initialized.' };
    this.state = adoptAwaiting(this.state, this.awaiting);
    this.awaiting = [];
    // Provider failures are data inside the sources layer, so a dead feed leaves the outbox untouched.
    const reaching = await pollPort(this.state.portId);
    this.state = { ...this.state, outbox: enqueueLive(this.state, reaching.map(toDisruption)) };
    const committed = this.state;
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
    let decided: readonly BoardMessage[] = [];
    const post: BoardIo['post'] = async (_identity, message) => { decided = [...decided, message]; return relaySuccess(message.id); };
    const watched = await watchPort({ read, post }, committed.relay, committed.board ?? emptyMemory,
      { portId: place.id, name: place.name, coordinates: place.coordinates, now: new Date(), notices: reaching });
    const latest = this.state ?? committed;
    this.state = { ...latest, board: watched.memory, boardOutbox: enqueue(latest.boardOutbox ?? [], decided), ...(consumed ? { synced: true, inbox: drainInbox(latest.inbox, { board: heard, disruptions: [] }) } : {}) };
    return watched.outcome;
  }

  /**
   * What this port has decided or been asked to say that Relay has not acknowledged yet. The server echoes it locally at once and
   * writes it to Relay itself: an actor that awaited Relay would hold its own queue (deliver, check) for as long as Relay takes.
   */
  async unpublished(): Promise<Outgoing<Disruption> | null> {
    return this.state ? { relay: this.state.relay, board: this.state.boardOutbox ?? [], disruptions: this.state.outbox } : null;
  }

  /** Relay acknowledged these: board posts leave the outbox, disruptions move to `published`. */
  async acknowledge(sent: Readonly<{ board: readonly string[]; disruptions: readonly string[] }>): Promise<void> {
    if (!this.state) return;
    const done = this.state.outbox.filter(event => sent.disruptions.includes(event.id));
    this.state = {
      ...this.state, ready: true, checkedAt: new Date().toISOString(),
      outbox: without(this.state.outbox, sent.disruptions), published: [...this.state.published, ...done.map(event => event.id)],
      boardOutbox: without(this.state.boardOutbox ?? [], sent.board),
    };
  }

  /** The alarm's own write path, for when no server is driving: the same steps the server performs, through the same `transmit`. */
  async publish(): Promise<RelayOutcome<null>> {
    const outgoing = await this.unpublished();
    if (!outgoing || !this.state) return { status: 'unavailable', message: 'Port monitoring has not been initialized.' };
    const connection = await connect(this.state, this.state.portId === 'singapore');
    if (connection.status === 'unavailable') return connection;
    const sent = await transmit(outgoing, {
      post: message => postBoard(outgoing.relay, message),
      publish: disruption => attemptRelay(() => publishDisruption(outgoing.relay, disruption), 'Agent Relay publication is unavailable. The disruption remains queued for retry.'),
    });
    await this.acknowledge({ board: sent.board, disruptions: sent.disruptions });
    return sent.failure ? { status: 'unavailable', message: sent.failure } : relaySuccess(null);
  }

  async onAlarm(): Promise<void> {
    await this.check();
    await this.publish();
  }
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
    const decided = commitDecisions(start.board ?? emptyBoardMemory, decideBoard(start.board ?? emptyBoardMemory, { shipment: assessed.shipment, situation: watched.state?.situation ?? null, now }));
    const latest = this.state ?? start;
    this.state = { ...start, ready: true, shipment: assessed.shipment, assessmentCache: assessed.cache, cursor: channel.value.cursor, telemetry: watched.state, board: decided.memory, seen, checkedAt: now, synced: true, inbox: drainInbox(latest.inbox, heard), boardOutbox: enqueue(latest.boardOutbox ?? [], decided.messages) };
    return relaySuccess(this.state.shipment);
  }

  /** What this ship has decided to say that Relay has not acknowledged yet; the server echoes it locally and writes it to Relay itself. */
  async unpublished(): Promise<Outgoing<Disruption> | null> {
    return this.state ? { relay: this.state.relay, board: this.state.boardOutbox ?? [], disruptions: [] } : null;
  }

  async acknowledge(sent: readonly string[]): Promise<void> {
    if (this.state) this.state = { ...this.state, boardOutbox: without(this.state.boardOutbox ?? [], sent) };
  }

  /** The alarm's own write path, for when no server is driving. */
  async publish(): Promise<RelayOutcome<null>> {
    const outgoing = await this.unpublished();
    if (!outgoing) return { status: 'unavailable', message: 'Port monitoring has not been initialized.' };
    const sent = await transmit(outgoing, { post: message => postBoard(outgoing.relay, message), publish: () => Promise.resolve(relaySuccess(null)) });
    await this.acknowledge(sent.board);
    return sent.failure ? { status: 'unavailable', message: sent.failure } : relaySuccess(null);
  }

  async onAlarm(): Promise<void> {
    await this.check();
    await this.publish();
  }
}
