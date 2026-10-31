import { Actor, Persisted } from 'durable-actors';
import type { BoardMessage } from '../../../core/board';
import { portById, type PortId } from '../../../core/ports';
import { relaySuccess, type Disruption, type RelayOutcome } from '../../../core/types';
import { postBoard, readBoard } from '../../relay/board';
import { attemptRelay, registerParticipant, relayChannel, type RelayIdentity } from '../../relay/client';
import { connect } from '../../relay/connect';
import { drainInbox, emptyInbox, mergeInbox, type Inbox } from '../../relay/inbox';
import { enqueue, transmit, without, type Outgoing } from '../../relay/outbox';
import { checkIntervalMs } from '../alarm';
import { emptyTrafficMemory, watchTraffic, type BoardIo, type TrafficMemory } from './traffic';

type TrafficState = Readonly<{
  city: PortId; relay: RelayIdentity; ready: boolean; memory: TrafficMemory;
  /** Heard by the server on the Relay stream; `synced` = the actor has read Relay once since it started, so it may live on the inbox alone. */
  inbox: Inbox; synced: boolean;
  /** Decided but not yet acknowledged by Relay: durable, retried in order, and visible to the server at once through unpublished(). */
  outbox: readonly BoardMessage[];
}>;

/** A city's traffic watch: reads what ships say on the board about its approaches, and reports the anchored queue and the arrivals due. */
export class TrafficWatch extends Actor {
  @Persisted private state: TrafficState | null = null;
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

  async initialize(workspaceId: string, city: PortId, workspaceKey: string, createChannel: boolean): Promise<RelayOutcome<null>> {
    if (this.state?.ready) return relaySuccess(null);
    await this.scheduleCheck();
    if (!this.state) {
      const registration = await attemptRelay(() => registerParticipant(workspaceKey, this.id, relayChannel(workspaceId)), 'Agent Relay registration is unavailable. Retry initialization.');
      if (registration.status === 'unavailable') return registration;
      this.state = { city, relay: registration.value, ready: false, memory: emptyTrafficMemory, inbox: emptyInbox, synced: false, outbox: [] };
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

  async check(): Promise<RelayOutcome<null>> {
    await this.scheduleCheck();
    if (!this.state) return { status: 'unavailable', message: 'The traffic watch has not been initialized.' };
    const committed = this.state;
    const place = portById.get(committed.city);
    if (!place) return relaySuccess(null);
    const heard = committed.inbox.board;
    // Relay only completes the history; the watch decides from what it holds and what was delivered locally, whatever Relay does.
    const history = committed.synced ? null : await readBoard(committed.relay, committed.memory.cursor);
    const fromRelay = history?.status === 'ok' ? history.value : null;
    const messages = [...new Map([...(fromRelay?.messages ?? []), ...heard].map(message => [message.id, message] as const)).values()];
    const read: BoardIo['read'] = async () => relaySuccess({ messages, cursor: fromRelay?.cursor ?? committed.memory.cursor });
    const post: BoardIo['post'] = async (_identity, message) => relaySuccess(message.id);
    const watched = await watchTraffic({ read, post }, committed.relay, committed.memory, { city: place.id, coordinates: place.coordinates, now: new Date() });
    const latest = this.state ?? committed;
    this.state = {
      ...latest, memory: watched.memory, outbox: enqueue(latest.outbox, watched.decided ? [watched.decided] : []),
      synced: latest.synced || fromRelay !== null, inbox: drainInbox(latest.inbox, { board: heard, disruptions: [] }),
    };
    return history?.status === 'unavailable' ? history : watched.outcome;
  }

  /** What this watch has decided that Relay has not acknowledged yet; the server echoes it at once and writes it to Relay itself. */
  async unpublished(): Promise<Outgoing<Disruption> | null> {
    return this.state ? { relay: this.state.relay, board: this.state.outbox, disruptions: [] } : null;
  }

  /** Relay acknowledged these board posts: they leave the outbox. */
  async acknowledge(sent: Readonly<{ board: readonly string[]; disruptions: readonly string[] }>): Promise<void> {
    if (this.state) this.state = { ...this.state, ready: true, outbox: without(this.state.outbox, sent.board) };
  }

  /** The alarm's own write path, for when no server is driving: the same steps the server performs, through the same `transmit`. */
  async publish(): Promise<RelayOutcome<null>> {
    const outgoing = await this.unpublished();
    if (!outgoing || !this.state) return { status: 'unavailable', message: 'The traffic watch has not been initialized.' };
    const connection = await connect(this.state, this.state.city === 'singapore');
    if (connection.status === 'unavailable') return connection;
    const sent = await transmit(outgoing, { post: message => postBoard(outgoing.relay, message), publish: () => Promise.resolve(relaySuccess(null)) });
    await this.acknowledge({ board: sent.board, disruptions: [] });
    return sent.failure ? { status: 'unavailable', message: sent.failure } : relaySuccess(null);
  }

  async onAlarm(): Promise<void> {
    await this.check();
    await this.publish();
  }
}
