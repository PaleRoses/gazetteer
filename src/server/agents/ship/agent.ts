import { Actor, Persisted } from 'durable-actors';
import { relaySuccess, type Disruption, type RelayOutcome, type Risk, type Shipment } from '../../../core/types';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { shipMindFromEnv } from '../../assessment/mind';
import type { AssessmentCache } from '../../assessment/assess';
import { postBoard, readChannel, type ChannelRead } from '../../relay/board';
import type { BoardMessage } from '../../../core/board';
import type { ShipBoardMemory } from './board';
import type { Reactions } from './react';
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
import { attemptRelay, registerParticipant, relayChannel, type RelayIdentity } from '../../relay/client';
import { checkIntervalMs } from '../alarm';
import { connect } from '../../relay/connect';

type ShipmentState = Readonly<{ shipment: Shipment; relay: RelayIdentity; ready: boolean; checkedAt: string | null; assessmentCache?: AssessmentCache; cursor?: Cursor | null; mmsi?: string; telemetry?: TelemetryState; board?: ShipBoardMemory; baseRisk?: Risk; reactions?: Reactions; mind?: string | null; seen?: readonly BoardMessage[]; inbox?: Inbox; synced?: boolean; boardOutbox?: readonly BoardMessage[] }>;
const assessment = shipMindFromEnv(process.env, query);
const telemetrySource = telemetrySourceFromEnv(process.env);
const demo = demoEnabled(process.env);
/** A read plus whatever the server already handed over: local echoes may not have reached Relay yet. */
const unionHeard = (read: RelayOutcome<ChannelRead>, heard: Inbox): RelayOutcome<ChannelRead> => read.status === 'unavailable' ? read : relaySuccess({
  ...read.value,
  board: [...new Map([...read.value.board, ...heard.board].map(message => [message.id, message] as const)).values()],
  disruptions: [...new Map([...read.value.disruptions, ...heard.disruptions].map(item => [item.id, item] as const)).values()],
});

export class ShipmentAgent extends Actor {
  @Persisted private state: ShipmentState | null = null;
  @Persisted private nextCheckAt: number | null = null;

  async resume(): Promise<void> {
    if (!this.state) return;
    this.state = { ...this.state, shipment: named(this.state.shipment, demoShipments().map(item => item.id)), synced: false };
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
    const thought = await think({ assess: assessment, binding: (shipment, mmsi) => telemetryBinding(shipment, mmsi, demo, telemetrySource) }, start, channel.status === 'ok' ? channel.value : null, now);
    if (channel.status === 'unavailable') {
      this.state = { ...start, ...thought.state };
      return channel;
    }
    const latest = this.state ?? start;
    this.state = { ...start, ...thought.state, ready: true, cursor: channel.value.cursor, checkedAt: now, synced: true, inbox: drainInbox(latest.inbox, heard), boardOutbox: enqueue(latest.boardOutbox ?? [], thought.messages) };
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
