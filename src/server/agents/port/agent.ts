import { Actor, Persisted } from 'durable-actors';
import { ports, type PortId } from '../../../core/ports';
import { relaySuccess, type Disruption, type RelayOutcome } from '../../../core/types';
import { postBoard, readBoard } from '../../relay/board';
import { emptyMemory, type PortMemory } from './memory';
import { watchPort, type BoardIo } from './watch';
import { accept, adopt, waiting } from './outbox';
import { pollPort } from '../../sources/poll';
import type { BoardMessage } from '../../../core/board';
import { toDisruption } from '../../sources/disruption';
import { drainInbox, mergeInbox, type Inbox } from '../../relay/inbox';
import { enqueue, transmit, without, type Outgoing } from '../../relay/outbox';
import { attemptRelay, publishDisruption, registerParticipant, relayChannel, type RelayIdentity } from '../../relay/client';
import { checkIntervalMs } from '../alarm';
import { connect } from '../../relay/connect';

type PortState = Readonly<{
  portId: PortId; relay: RelayIdentity; ready: boolean;
  outbox: readonly Disruption[]; published: readonly string[]; checkedAt: string | null; board?: PortMemory;
  /** Heard by the server on the Relay stream; `synced` = the actor has read Relay once since it started, so it may live on the inbox alone. */
  inbox?: Inbox; synced?: boolean;
  /** Decided but not yet acknowledged by Relay: durable, retried in order, and visible to the server at once through unpublished(). */
  boardOutbox?: readonly BoardMessage[];
}>;
const enqueueLive = (state: PortState, incoming: readonly Disruption[]): readonly Disruption[] =>
  [...state.outbox, ...incoming.filter(live => !state.outbox.some(event => event.id === live.id) && !state.published.includes(live.id))];
/** Registered: what waited for Relay joins the outbox, and nothing is left waiting. */
const adoptAwaiting = (state: PortState, awaiting: readonly Disruption[] | null): PortState =>
  ({ ...state, outbox: adopt({ pending: awaiting ?? [], outbox: state.outbox, published: state.published }).outbox });

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
