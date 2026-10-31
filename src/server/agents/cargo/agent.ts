import { query } from '@anthropic-ai/claude-agent-sdk';
import { Actor, Persisted } from 'durable-actors';
import type { BoardMessage } from '../../../core/board';
import { recoveryMessage, type Commitments, type Plan, type RecoveryMessage } from '../../../core/recovery';
import { relaySuccess, type Disruption, type RelayOutcome } from '../../../core/types';
import { phraseFromEnv } from '../../assessment/mind';
import { ledgerAt } from '../../booking/ledger';
import { postBoard, readBoard } from '../../relay/board';
import type { RelayIdentity } from '../../relay/client';
import { joinRelay } from '../../relay/connect';
import { drainInbox, emptyInbox, mergeInbox, type Inbox } from '../../relay/inbox';
import { enqueue, transmit, without, type Outgoing } from '../../relay/outbox';
import { checkIntervalMs } from '../alarm';
import { cycle } from './cycle.js';
import { hear, openCase, reconcile, type Booking, type CaseState } from './negotiate.js';
import { wordPlans } from './voice.js';

type CargoState = Readonly<{
  workspaceId: string; relay: RelayIdentity | null; ready: boolean;
  /** The ledger file, given by the server at initialization; the cargo agent only reads it, the providers write it. */
  bookingsPath: string;
  /** The commitments and the whole case: durable, so a restarted agent resumes mid-negotiation and re-decides the same ids and keys. */
  recovery: CaseState;
  inbox: Inbox; synced: boolean;
  /** The cargo mind's own session, resumed when it words the next plan; null until it has spoken. */
  mind?: string | null;
  /** Decided but not yet acknowledged by Relay: durable, retried in order, and visible to the server at once through unpublished(). */
  outbox: readonly BoardMessage[];
}>;
export type CargoCase = Readonly<{ caseId: string; method: 'rule-based'; plan: Plan | null; bookings: readonly Booking[]; delivered: string | null }>;

/** The cargo mind words plans when the workspace id exists; without it nothing spawns and the rule-based words stand. */
const phrase = phraseFromEnv(process.env, query);
const isRecovery = (message: BoardMessage): message is RecoveryMessage => recoveryMessage.safeParse(message).success;


/**
 * The refrigerated container's own agent: it remembers its commitments and negotiates its recovery on the board. The decisions are the
 * deterministic solver's; its mind, when the workspace id exists, only words its plans (labelled ai-assessed when it did). It posts holds, confirms and
 * releases keyed by caseId:offerId; the providers write the ledger, and the cargo agent only reads it back each check as the truth.
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
    if (this.state) return relaySuccess(null);
    await this.scheduleCheck();
    this.state = {
        workspaceId, relay: null, ready: false, bookingsPath, recovery: openCase(caseId, { id: this.id, vessel }, commitments),
        inbox: emptyInbox, synced: false, outbox: [],
      };
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

  /** One step of the negotiation: hear the board, read the ledger back, decide, and queue what to say. */
  async check(): Promise<RelayOutcome<null>> {
    await this.scheduleCheck();
    if (!this.state) return { status: 'unavailable', message: 'The cargo agent has not been initialized.' };
    const committed = this.state;
    const heard = committed.inbox.board;
    const member = committed.ready ? committed.relay : null;
    const read = committed.synced || !member ? relaySuccess({ messages: heard }) : await readBoard(member, null);
    if (read.status === 'unavailable') return read;
    const messages = [...new Map([...read.value.messages, ...heard].map(message => [message.id, message] as const)).values()].filter(isRecovery);
    const ledger = ledgerAt(committed.bookingsPath);
    const known = reconcile(hear(committed.recovery, messages), key => ledger.find(key)?.status);
    const done = cycle(known, new Date().toISOString());
    const voiced = await wordPlans(done.state, done.messages, phrase, committed.mind ?? null);
    const latest = this.state ?? committed;
    this.state = {
      ...latest, recovery: done.state, mind: voiced.session, outbox: enqueue(latest.outbox, voiced.messages), synced: committed.synced || member !== null,
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
    return this.state ? { relay: this.state.ready ? this.state.relay : null, board: this.state.outbox, disruptions: [] } : null;
  }

  /** Relay acknowledged these board posts: they leave the outbox. */
  async acknowledge(sent: Readonly<{ board: readonly string[]; disruptions: readonly string[] }>): Promise<void> {
    if (this.state) this.state = { ...this.state, outbox: without(this.state.outbox, sent.board) };
  }

  /** The alarm's own write path, for when no server is driving: the same steps the server performs, through the same `transmit`. */
  async publish(): Promise<RelayOutcome<null>> {
    const outgoing = await this.unpublished();
    if (!outgoing || !this.state) return { status: 'unavailable', message: 'The cargo agent has not been initialized.' };
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
