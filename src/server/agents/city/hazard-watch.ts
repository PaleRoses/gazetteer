import { Actor, Persisted } from 'durable-actors';
import type { BoardMessage, HazardReport } from '../../../core/board';
import type { PortId } from '../../../core/ports';
import { relaySuccess, type Disruption, type RelayOutcome } from '../../../core/types';
import { postBoard } from '../../relay/board';
import { attemptRelay, publishDisruption, type RelayIdentity } from '../../relay/client';
import { joinRelay } from '../../relay/connect';
import { enqueue, transmit, without, type Outgoing } from '../../relay/outbox';
import { toDisruption } from '../../sources/disruption';
import { pollPort } from '../../sources/poll';
import { checkIntervalMs } from '../alarm';
import { assessHazards, decideHazards } from './hazards';
import { accept, adopt, waiting } from './outbox';

type HazardState = Readonly<{
  city: PortId; relay: RelayIdentity | null; ready: boolean;
  outbox: readonly Disruption[]; published: readonly string[];
  /** The last report this watch decided; its sequence numbers the next one. */
  report: HazardReport | null;
  /** Decided but not yet acknowledged by Relay: durable, retried in order, and visible to the server at once through unpublished(). */
  boardOutbox: readonly BoardMessage[];
}>;
const enqueueLive = (state: HazardState, incoming: readonly Disruption[]): readonly Disruption[] =>
  [...state.outbox, ...incoming.filter(live => !state.outbox.some(event => event.id === live.id) && !state.published.includes(live.id))];
/** Registered: what waited for Relay joins the outbox, and nothing is left waiting. */
const adoptAwaiting = (state: HazardState, awaiting: readonly Disruption[] | null): HazardState =>
  ({ ...state, outbox: adopt({ pending: awaiting ?? [], outbox: state.outbox, published: state.published }).outbox });

/** A city's hazard watch: polls the live hazard feeds for its city, holds its simulated disruptions, and reports the hazards in force. */
export class HazardWatch extends Actor {
  @Persisted private state: HazardState | null = null;
  @Persisted private nextCheckAt: number | null = null;
  /** Simulated disruptions accepted before this actor was registered with Relay: local, persisted, adopted into the outbox on registration. */
  @Persisted private awaiting: readonly Disruption[] | null = null;

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

  async initialize(workspaceId: string, city: PortId, workspaceKey: string, createChannel: boolean): Promise<RelayOutcome<null>> {
    if (this.state) return relaySuccess(null);
    await this.scheduleCheck();
    this.state = { city, relay: null, ready: false, outbox: [], published: [], report: null, boardOutbox: [] };
    this.state = adoptAwaiting(this.state, this.awaiting);
    this.awaiting = [];
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

  /** Durable from the moment it is accepted: before registration it waits in `pending`, with no Relay needed. */
  async simulate(disruption: Disruption): Promise<void> {
    if (this.state ? disruption.portId !== this.state.city : !this.id.endsWith(`-city-${disruption.portId}-hazards`)) return;
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
    if (!this.state) return { status: 'unavailable', message: 'The hazard watch has not been initialized.' };
    this.state = adoptAwaiting(this.state, this.awaiting);
    this.awaiting = [];
    // Provider failures are data inside the sources layer, so a dead feed leaves the outbox untouched.
    const reaching = await pollPort(this.state.city);
    const latest = this.state;
    const report = decideHazards(assessHazards(latest.city, reaching), latest.report, new Date());
    this.state = {
      ...latest, outbox: enqueueLive(latest, reaching.map(toDisruption)),
      ...(report ? { report, boardOutbox: enqueue(latest.boardOutbox, [report]) } : {}),
    };
    return relaySuccess(null);
  }

  /**
   * What this watch has decided or been asked to say that Relay has not acknowledged yet. The server echoes it locally at once and
   * writes it to Relay itself: an actor that awaited Relay would hold its own queue for as long as Relay takes.
   */
  async unpublished(): Promise<Outgoing<Disruption> | null> {
    return this.state ? { relay: this.state.ready ? this.state.relay : null, board: this.state.boardOutbox, disruptions: this.state.outbox } : null;
  }

  /** Relay acknowledged these: board posts leave the outbox, disruptions move to `published`. */
  async acknowledge(sent: Readonly<{ board: readonly string[]; disruptions: readonly string[] }>): Promise<void> {
    if (!this.state) return;
    const done = this.state.outbox.filter(event => sent.disruptions.includes(event.id));
    this.state = {
      ...this.state,
      outbox: without(this.state.outbox, sent.disruptions), published: [...this.state.published, ...done.map(event => event.id)],
      boardOutbox: without(this.state.boardOutbox, sent.board),
    };
  }

  /** The alarm's own write path, for when no server is driving: the same steps the server performs, through the same `transmit`. */
  async publish(): Promise<RelayOutcome<null>> {
    const outgoing = await this.unpublished();
    if (!outgoing || !this.state) return { status: 'unavailable', message: 'The hazard watch has not been initialized.' };
    const { relay } = outgoing;
    if (!relay) return { status: 'unavailable', message: 'Not yet a member of the Relay channel.' };
    const sent = await transmit(outgoing, {
      post: message => postBoard(relay, message),
      publish: disruption => attemptRelay(() => publishDisruption(relay, disruption), 'Agent Relay publication is unavailable. The disruption remains queued for retry.'),
    });
    await this.acknowledge({ board: sent.board, disruptions: sent.disruptions });
    return sent.failure ? { status: 'unavailable', message: sent.failure } : relaySuccess(null);
  }

  async onAlarm(): Promise<void> {
    await this.check();
    await this.publish();
  }
}
