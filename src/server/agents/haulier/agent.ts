import { Actor, Persisted } from 'durable-actors';
import type { BoardMessage } from '../../../core/board';
import type { PortId } from '../../../core/ports';
import { recoveryMessage, type RecoveryMessage } from '../../../core/recovery';
import { relaySuccess, type Disruption, type RelayOutcome } from '../../../core/types';
import { ledgerAt } from '../../booking/ledger';
import { postBoard, readBoard } from '../../relay/board';
import type { RelayIdentity } from '../../relay/client';
import { joinRelay } from '../../relay/connect';
import { drainInbox, emptyInbox, mergeInbox, type Inbox } from '../../relay/inbox';
import { enqueue, transmit, without, type Outgoing } from '../../relay/outbox';
import { checkIntervalMs } from '../alarm';
import { emptyHaulierMemory, hear, withdrawTruck, type HaulierContext, type HaulierMemory } from './decide';
import type { Truck } from './truck.js';

type HaulierState = Readonly<{
  city: PortId; workspaceId: string; relay: RelayIdentity | null; ready: boolean;
  /** The ledger file and the city's departures, given by the server at initialization: the actor decides nothing about when trucks run. */
  bookingsPath: string; trucks: readonly Truck[];
  memory: HaulierMemory;
  inbox: Inbox; synced: boolean;
  /** Decided but not yet acknowledged by Relay: durable, retried in order, and visible to the server at once through unpublished(). */
  outbox: readonly BoardMessage[];
}>;

const contextOf = (state: HaulierState): HaulierContext =>
  ({ city: state.city, workspaceId: state.workspaceId, trucks: state.trucks, now: new Date().toISOString(), ledger: ledgerAt(state.bookingsPath) });

const isRecovery = (message: BoardMessage): message is RecoveryMessage => recoveryMessage.safeParse(message).success;

/** A city's haulier: answers requests for a truck from its schedule, writes the ledger for the holds, confirms and releases it hears for its trucks (the owner of the physical resource writes it), and withdraws a truck, with its bookings, on the demo's say-so. */
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
    if (this.state) return relaySuccess(null);
    await this.scheduleCheck();
    this.state = { city, workspaceId, relay: null, ready: false, bookingsPath, trucks, memory: emptyHaulierMemory, inbox: emptyInbox, synced: false, outbox: [] };
    return relaySuccess(null);
  }

  /** Relay membership, off the readiness path: the server calls this in the background and retries it with backoff. Registered once, remembered at once. */
  async join(workspaceId: string, workspaceKey: string, createChannel: boolean): Promise<RelayOutcome<null>> {
    if (!this.state) return { status: 'unavailable', message: 'Not initialized.' };
    if (this.state.ready) return relaySuccess(null);
    const member = await joinRelay(this.state, { name: this.id, workspaceId, workspaceKey, createChannel }, relay => { this.state = this.state && { ...this.state, relay }; });
    if (member.status === 'unavailable') return member;
    this.state = this.state && { ...this.state, relay: member.value, ready: true };
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
    // Relay only completes the history; the haulier decides from what it holds and what was delivered locally, whatever Relay does.
    const history = committed.synced || !committed.ready || !committed.relay ? null : await readBoard(committed.relay, null);
    const fromRelay = history?.status === 'ok' ? history.value.messages : [];
    const messages = [...new Map([...fromRelay, ...heard].map(message => [message.id, message] as const)).values()].filter(isRecovery);
    const decided = hear(contextOf(committed), committed.memory, messages);
    const latest = this.state ?? committed;
    this.state = {
      ...latest, memory: decided.memory, outbox: enqueue(latest.outbox, decided.posts),
      synced: latest.synced || history?.status === 'ok', inbox: drainInbox(latest.inbox, { board: heard, disruptions: [] }),
    };
    return history?.status === 'unavailable' ? history : relaySuccess(null);
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
    return this.state ? { relay: this.state.ready ? this.state.relay : null, board: this.state.outbox, disruptions: [] } : null;
  }

  /** Relay acknowledged these board posts: they leave the outbox. */
  async acknowledge(sent: Readonly<{ board: readonly string[]; disruptions: readonly string[] }>): Promise<void> {
    if (this.state) this.state = { ...this.state, outbox: without(this.state.outbox, sent.board) };
  }

  /** The alarm's own write path, for when no server is driving: the same steps the server performs, through the same `transmit`. */
  async publish(): Promise<RelayOutcome<null>> {
    const outgoing = await this.unpublished();
    if (!outgoing || !this.state) return { status: 'unavailable', message: 'The haulier has not been initialized.' };
    const { relay } = outgoing;
    if (!relay) return { status: 'unavailable', message: 'Not yet a member of the Relay channel.' };
    const sent = await transmit(outgoing, { post: message => postBoard(relay, message), publish: () => Promise.resolve(relaySuccess(null)) });
    await this.acknowledge({ board: sent.board, disruptions: [] });
    return sent.failure ? { status: 'unavailable', message: sent.failure } : relaySuccess(null);
  }

  async onAlarm(): Promise<void> {
    await this.check();
    await this.publish();
  }
}
