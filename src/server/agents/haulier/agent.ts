import { Actor, Persisted } from 'durable-actors';
import type { BoardMessage } from '../../../core/board';
import type { PortId } from '../../../core/ports';
import { recoveryMessage, type RecoveryMessage } from '../../../core/recovery';
import { relaySuccess, type Disruption, type RelayOutcome } from '../../../core/types';
import { createBookings, type Bookings } from '../../booking/ledger';
import { postBoard, readBoard } from '../../relay/board';
import { attemptRelay, registerParticipant, relayChannel, type RelayIdentity } from '../../relay/client';
import { connect } from '../../relay/connect';
import { drainInbox, emptyInbox, mergeInbox, type Inbox } from '../../relay/inbox';
import { enqueue, transmit, without, type Outgoing } from '../../relay/outbox';
import { checkIntervalMs } from '../alarm';
import { emptyHaulierMemory, hear, withdrawTruck, type HaulierContext, type HaulierMemory } from './decide';
import type { Truck } from './truck.js';

type HaulierState = Readonly<{
  city: PortId; workspaceId: string; relay: RelayIdentity; ready: boolean;
  /** The ledger file and the city's departures, given by the server at initialization: the actor decides nothing about when trucks run. */
  bookingsPath: string; trucks: readonly Truck[];
  memory: HaulierMemory;
  inbox: Inbox; synced: boolean;
  /** Decided but not yet acknowledged by Relay: durable, retried in order, and visible to the server at once through unpublished(). */
  outbox: readonly BoardMessage[];
}>;

/** One ledger connection per file for the life of the process: SQLite in WAL mode shares safely with the server's own connection. */
const ledgers = new Map<string, Bookings>();
const ledgerAt = (path: string): Bookings => ledgers.get(path) ?? (() => { const opened = createBookings(path); ledgers.set(path, opened); return opened; })();

const contextOf = (state: HaulierState): HaulierContext =>
  ({ city: state.city, trucks: state.trucks, now: new Date().toISOString(), ledger: ledgerAt(state.bookingsPath) });

const isRecovery = (message: BoardMessage): message is RecoveryMessage => recoveryMessage.safeParse(message).success;

/** A city's haulier: answers requests for a truck from its schedule and withdraws a truck, with its ledger bookings, on the demo's say-so. The cargo agent does the booking. */
export class HaulierAgent extends Actor {
  @Persisted private state: HaulierState | null = null;
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

  async initialize(workspaceId: string, city: PortId, workspaceKey: string, createChannel: boolean, bookingsPath: string, trucks: readonly Truck[]): Promise<RelayOutcome<null>> {
    if (this.state?.ready) { this.state = { ...this.state, trucks }; return relaySuccess(null); }
    await this.scheduleCheck();
    if (!this.state) {
      const registration = await attemptRelay(() => registerParticipant(workspaceKey, this.id, relayChannel(workspaceId)), 'Agent Relay registration is unavailable. Retry initialization.');
      if (registration.status === 'unavailable') return registration;
      this.state = { city, workspaceId, relay: registration.value, ready: false, bookingsPath, trucks, memory: emptyHaulierMemory, inbox: emptyInbox, synced: false, outbox: [] };
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
    if (!this.state) return { status: 'unavailable', message: 'The haulier has not been initialized.' };
    const committed = this.state;
    const heard = committed.inbox.board;
    const read = committed.synced ? relaySuccess({ messages: heard }) : await readBoard(committed.relay, null);
    if (read.status === 'unavailable') return read;
    const messages = [...new Map([...read.value.messages, ...heard].map(message => [message.id, message] as const)).values()].filter(isRecovery);
    const decided = hear(contextOf(committed), committed.memory, messages);
    const latest = this.state ?? committed;
    this.state = { ...latest, memory: decided.memory, outbox: enqueue(latest.outbox, decided.posts), synced: true, inbox: drainInbox(latest.inbox, { board: heard, disruptions: [] }) };
    return relaySuccess(null);
  }

  /** The demo's control: withdraw the named truck offer, or else the open one that leaves last. Returns the offer withdrawn, or null when there was none. */
  async withdraw(reason: string, offerId: string | null): Promise<RelayOutcome<string | null>> {
    if (!this.state) return { status: 'unavailable', message: 'The haulier has not been initialized.' };
    const done = withdrawTruck(contextOf(this.state), this.state.memory, reason, offerId ?? undefined);
    this.state = { ...this.state, memory: done.memory, outbox: enqueue(this.state.outbox, done.posts) };
    return relaySuccess(done.withdrawn);
  }

  /** What this haulier has decided that Relay has not acknowledged yet; the server echoes it at once and writes it to Relay itself. */
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
    if (!outgoing || !this.state) return { status: 'unavailable', message: 'The haulier has not been initialized.' };
    const connection = await connect(this.state, false);
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
