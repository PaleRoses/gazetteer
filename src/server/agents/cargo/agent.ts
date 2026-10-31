import { Actor, Persisted } from 'durable-actors';
import type { BoardMessage } from '../../../core/board';
import { recoveryMessage, type Commitments, type Plan, type RecoveryMessage } from '../../../core/recovery';
import { relaySuccess, type Disruption, type RelayOutcome } from '../../../core/types';
import { createBookings, type Bookings } from '../../booking/ledger';
import { postBoard, readBoard } from '../../relay/board';
import { attemptRelay, registerParticipant, relayChannel, type RelayIdentity } from '../../relay/client';
import { connect } from '../../relay/connect';
import { drainInbox, emptyInbox, mergeInbox, type Inbox } from '../../relay/inbox';
import { enqueue, transmit, without, type Outgoing } from '../../relay/outbox';
import { checkIntervalMs } from '../alarm';
import { hear, negotiate, openCase, reconcile, settle, type Booking, type CaseState } from './negotiate.js';

type CargoState = Readonly<{
  workspaceId: string; relay: RelayIdentity; ready: boolean;
  /** The ledger file, given by the server at initialization; the cargo agent only reads it, the providers write it. */
  bookingsPath: string;
  /** The commitments and the whole case: durable, so a restarted agent resumes mid-negotiation and re-decides the same ids and keys. */
  recovery: CaseState;
  inbox: Inbox; synced: boolean;
  /** Decided but not yet acknowledged by Relay: durable, retried in order, and visible to the server at once through unpublished(). */
  outbox: readonly BoardMessage[];
}>;
export type CargoCase = Readonly<{ caseId: string; method: 'rule-based'; plan: Plan | null; bookings: readonly Booking[]; delivered: string | null }>;

const ledgers = new Map<string, Bookings>();
const ledgerAt = (path: string): Bookings => ledgers.get(path) ?? (() => { const opened = createBookings(path); ledgers.set(path, opened); return opened; })();
const isRecovery = (message: BoardMessage): message is RecoveryMessage => recoveryMessage.safeParse(message).success;

/**
 * The refrigerated container's own agent: it remembers its commitments and negotiates its recovery on the board. Deterministic and labelled
 * rule-based; the providers write the ledger when they hear its holds, confirms and releases, and it reads the ledger back as the truth.
 */
export class CargoAgent extends Actor {
  @Persisted private state: CargoState | null = null;
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

  /** Opens the case once; a second call (a restart, a replayed request) keeps the persisted case and its commitments as they are. */
  async initialize(workspaceId: string, workspaceKey: string, bookingsPath: string, caseId: string, vessel: string, commitments: Commitments): Promise<RelayOutcome<null>> {
    if (this.state?.ready) return relaySuccess(null);
    await this.scheduleCheck();
    if (!this.state) {
      const registration = await attemptRelay(() => registerParticipant(workspaceKey, this.id, relayChannel(workspaceId)), 'Agent Relay registration is unavailable. Retry initialization.');
      if (registration.status === 'unavailable') return registration;
      this.state = {
        workspaceId, relay: registration.value, ready: false, bookingsPath, recovery: openCase(caseId, { id: this.id, vessel }, commitments),
        inbox: emptyInbox, synced: false, outbox: [],
      };
    }
    const connection = await connect(this.state, false);
    if (connection.status === 'unavailable') return connection;
    this.state = { ...this.state, ready: true };
    return relaySuccess(null);
  }

  /** The server heard these on the Relay stream: take them locally instead of reading Relay. */
  async deliver(batch: Inbox): Promise<void> {
    if (this.state) this.state = { ...this.state, inbox: mergeInbox(this.state.inbox, { board: batch.board, disruptions: [] }) };
  }

  /** One step of the negotiation: hear the board, read the ledger back, decide, and queue what to say. */
  async check(): Promise<RelayOutcome<null>> {
    await this.scheduleCheck();
    if (!this.state) return { status: 'unavailable', message: 'The cargo agent has not been initialized.' };
    const committed = this.state;
    const heard = committed.inbox.board;
    const read = committed.synced ? relaySuccess({ messages: heard }) : await readBoard(committed.relay, null);
    if (read.status === 'unavailable') return read;
    const messages = [...new Map([...read.value.messages, ...heard].map(message => [message.id, message] as const)).values()].filter(isRecovery);
    const ledger = ledgerAt(committed.bookingsPath);
    const known = reconcile(hear(committed.recovery, messages), key => ledger.find(key)?.status);
    const now = new Date().toISOString();
    const decided = negotiate(known, now);
    const settled = settle(decided.state, decided.actions, now);
    const latest = this.state ?? committed;
    this.state = {
      ...latest, recovery: settled.state, outbox: enqueue(latest.outbox, [...decided.messages, ...settled.messages]), synced: true,
      inbox: drainInbox(latest.inbox, { board: heard, disruptions: [] }),
    };
    return relaySuccess(null);
  }

  /** The case as the reservations panel shows it: the plan, the recovered delivery, and every booking with its status. */
  async snapshot(): Promise<CargoCase | null> {
    if (!this.state) return null;
    const { caseId, plan, bookings } = this.state.recovery;
    return { caseId, method: 'rule-based', plan, bookings, delivered: plan?.delivered ?? null };
  }

  /** What this cargo agent has decided that Relay has not acknowledged yet; the server echoes it at once and writes it to Relay itself. */
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
    if (!outgoing || !this.state) return { status: 'unavailable', message: 'The cargo agent has not been initialized.' };
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
