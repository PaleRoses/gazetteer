import { Actor, Ephemeral, Persisted } from 'durable-actors';
import { relaySuccess, type Disruption, type RelayOutcome, type Risk, type Shipment } from '../../../core/types';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { shipAskerFromEnv, shipMindFromEnv } from '../../assessment/mind';
import type { AssessmentCache } from '../../assessment/assess';
import { postBoard, readChannel, type ChannelRead } from '../../relay/board';
import type { BoardMessage } from '../../../core/board';
import { selectBoardEvidence, type ShipBoardMemory } from './board';
import type { Reactions } from './react';
import { hear } from './channel';
import { think } from './think';
import { demoShipments } from '../../../core/demo';
import { named } from '../../../core/names';
import type { TelemetryState } from './watch';
import { mmsiPattern } from '../../telemetry/telemetry';
import { telemetrySourceFromEnv } from '../../telemetry/source';
import { demoEnabled, telemetryBinding } from '../../telemetry/simulation';
import type { Cursor } from '../../relay/cursor';
import { drainInbox, emptyInbox, mergeInbox, type Inbox } from '../../relay/inbox';
import { enqueue, transmit, without, type Outgoing } from '../../relay/outbox';
import type { RelayIdentity } from '../../relay/client';
import { checkIntervalMs } from '../alarm';
import { joinRelay } from '../../relay/connect';

type ShipmentState = Readonly<{ paused?: boolean; shipment: Shipment; relay: RelayIdentity | null; ready: boolean; checkedAt: string | null; assessmentCache?: AssessmentCache; cursor?: Cursor | null; mmsi?: string; telemetry?: TelemetryState; board?: ShipBoardMemory; baseRisk?: Risk; reactions?: Reactions; mind?: string | null; seen?: readonly BoardMessage[]; inbox?: Inbox; synced?: boolean; boardOutbox?: readonly BoardMessage[] }>;
const assessment = shipMindFromEnv(process.env, query);
const asker = shipAskerFromEnv(process.env, query);
export type ShipAnswer = Readonly<{ status: 'answered'; answer: string; cited: readonly string[]; mind: string; session: string | null }> | Readonly<{ status: 'unavailable'; message: string }>;
const telemetrySource = telemetrySourceFromEnv(process.env);
const demo = demoEnabled(process.env);
export class ShipmentAgent extends Actor {
  @Persisted private paused = false;
  @Persisted private state: ShipmentState | null = null;
  @Persisted private nextCheckAt: number | null = null;
  /** The Relay history is read in the background, once, retried with backoff; the result is kept here and never persisted, so a lost one is simply read again. */
  @Ephemeral private history: ChannelRead | null = null;
  @Ephemeral private reading = false;
  @Ephemeral private failures = 0;
  @Ephemeral private retryAt = 0;
  @Ephemeral private failure: string | null = null;

  async resume(): Promise<void> {
    if (!this.state || this.state.paused || this.paused) return;
    this.state = { ...this.state, shipment: named(this.state.shipment, demoShipments().map(item => item.id)), synced: false };
    this.history = null;
    this.retryAt = 0;
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
    if (this.paused || this.state?.paused) return relaySuccess(null);
    if (this.state && shipment.voyage && this.state.shipment.voyage?.updatedAt !== shipment.voyage.updatedAt) {
      this.state = { ...this.state, shipment, assessmentCache: {}, telemetry: undefined, board: undefined, baseRisk: 'on-track', reactions: undefined, mind: null, seen: [], inbox: emptyInbox, boardOutbox: [] };
      await this.scheduleCheck();
    }
    if (this.state) return relaySuccess(null);
    await this.scheduleCheck();
    this.state = { shipment, relay: null, ready: false, checkedAt: null, ...(mmsi ? { mmsi } : {}) };
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

  async pause(): Promise<void> { this.paused = true; if (this.state) this.state = { ...this.state, paused: true, boardOutbox: [] }; }

  async snapshot(): Promise<Shipment | null> { return this.state?.shipment ?? null; }

  /** Read-only: the mind answers as itself from its own session and decides nothing; only the session it ran in is kept. */
  async ask(question: string): Promise<ShipAnswer> {
    if (!this.state) return { status: 'unavailable', message: 'This ship is not being monitored yet.' };
    const start = this.state;
    const now = new Date().toISOString();
    const result = await asker(question, start.mind ?? null, { shipment: start.shipment, board: selectBoardEvidence(start.shipment, start.seen ?? [], now), observation: null });
    if (this.state) this.state = { ...this.state, mind: result.session };
    return result.status === 'answered' ? { status: 'answered', answer: result.answer, cited: result.cited, mind: start.shipment.agent, session: result.session } : { status: 'unavailable', message: result.message };
  }

  /** The server heard these on the Relay stream (or authored them): take them locally instead of reading Relay. */
  async deliver(batch: Inbox): Promise<void> {
    if (this.state && !this.state.paused && !this.paused) this.state = { ...this.state, inbox: mergeInbox(this.state.inbox, batch) };
  }

  /** The one background read of the Relay history, unless it is under way, done, or backing off. Started by a check and never awaited by one. */
  private async readHistory(start: ShipmentState): Promise<void> {
    if (this.reading || this.history || Date.now() < this.retryAt) return;
    this.reading = true;
    const member = start.ready ? start.relay : null;
    const read = !member ? { status: 'unavailable' as const, message: 'Not yet a member of the Relay channel.' } : await readChannel(member, start.cursor ?? null).catch((): RelayOutcome<ChannelRead> => ({ status: 'unavailable', message: 'Agent Relay history is unavailable. Monitoring will retry.' }));
    if (read.status === 'ok') { this.history = read.value; this.failures = 0; this.failure = null; }
    else { this.failures += 1; this.failure = read.message; this.retryAt = Date.now() + Math.min(60_000, 2_000 * 2 ** this.failures); }
    this.reading = false;
  }

  async check(): Promise<RelayOutcome<Shipment>> {
    if (this.paused || this.state?.paused) return this.state ? relaySuccess(this.state.shipment) : { status: 'unavailable', message: 'Vessel removed from fleet.' };
    await this.scheduleCheck();
    if (!this.state) return { status: 'unavailable', message: 'Shipment monitoring has not been initialized.' };
    if (this.state.shipment.voyage?.status === 'planned' || this.state.shipment.voyage?.status === 'arrived') return relaySuccess(this.state.shipment);
    const start = this.state;
    const now = new Date().toISOString();
    const heard = start.inbox ?? emptyInbox;
    if (!start.synced) void this.readHistory(start);
    const hearing = hear(start, heard, this.history, this.failure);
    const thought = await think({ assess: assessment, binding: (shipment, mmsi) => telemetryBinding(shipment, mmsi, demo, telemetrySource) }, start, hearing.channel, now);
    if (this.paused || this.state?.paused) return this.state ? relaySuccess(this.state.shipment) : { status: 'unavailable', message: 'Vessel removed from fleet.' };
    const latest = this.state ?? start;
    this.state = { ...start, ...thought.state, ready: start.ready || hearing.synced, cursor: hearing.channel.cursor, checkedAt: now, synced: hearing.synced, inbox: drainInbox(latest.inbox, heard), boardOutbox: enqueue(latest.boardOutbox ?? [], thought.messages) };
    return hearing.unavailable === null ? relaySuccess(this.state.shipment) : { status: 'unavailable', message: hearing.unavailable };
  }

  /** What this ship has decided to say that Relay has not acknowledged yet; the server echoes it locally and writes it to Relay itself. */
  async unpublished(): Promise<Outgoing<Disruption> | null> {
    return this.state && !this.state.paused && !this.paused ? { relay: this.state.ready ? this.state.relay : null, board: this.state.boardOutbox ?? [], disruptions: [] } : null;
  }

  async acknowledge(sent: readonly string[]): Promise<void> {
    if (this.state) this.state = { ...this.state, boardOutbox: without(this.state.boardOutbox ?? [], sent) };
  }

  /** The alarm's own write path, for when no server is driving. */
  async publish(): Promise<RelayOutcome<null>> {
    const outgoing = await this.unpublished();
    if (!outgoing) return { status: 'unavailable', message: 'Port monitoring has not been initialized.' };
    const { relay } = outgoing;
    if (!relay) return { status: 'unavailable', message: 'Not yet a member of the Relay channel.' };
    const sent = await transmit(outgoing, { post: message => postBoard(relay, message), publish: () => Promise.resolve(relaySuccess(null)) });
    await this.acknowledge(sent.board);
    return sent.failure ? { status: 'unavailable', message: sent.failure } : relaySuccess(null);
  }

  async onAlarm(): Promise<void> {
    await this.check();
    await this.publish();
  }
}
