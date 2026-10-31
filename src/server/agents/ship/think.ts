import type { BoardMessage } from '../../../core/board';
import type { Risk, Shipment } from '../../../core/types';
import { assessNotices, type AssessDeps, type AssessmentCache } from '../../assessment/assess';
import type { ChannelRead } from '../../relay/board';
import type { Binding } from '../../telemetry/simulation';
import { commitDecisions, decideBoard, emptyBoardMemory, rememberBoard, selectBoardEvidence, type ShipBoardMemory } from './board';
import { react, type Reactions } from './react';
import { applyFloor, clearance, clearedChange, floorChange, riskFloor } from './risk-floor';
import { emptyTelemetryState, watchShipment, type TelemetryState } from './watch';

/** What a ship carries from one cycle to the next. */
export type Thoughts = Readonly<{
  shipment: Shipment; mmsi?: string; telemetry?: TelemetryState; assessmentCache?: AssessmentCache; board?: ShipBoardMemory;
  seen?: readonly BoardMessage[]; mind?: string | null; baseRisk?: Risk; baseChange?: string; floored?: readonly string[]; reactions?: Reactions;
}>;
export type Thinker = Readonly<{ assess: AssessDeps; binding: (shipment: Shipment, mmsi: string | undefined) => Binding | null }>;
export type Thought = Readonly<{ state: Thoughts; messages: readonly BoardMessage[] }>;

/**
 * One cycle of a ship's mind, in the order that keeps risk honest: restore the assessed risk, watch the water, react to the board, assess,
 * remember the assessed risk, then floor it with the rules. `read` is null when the channel could not be read: the ship still watches and says nothing.
 */
export async function think(thinker: Thinker, start: Thoughts, read: ChannelRead | null, now: string): Promise<Thought> {
  const seen = read ? rememberBoard(start.seen ?? [], read.board, now) : start.seen ?? [];
  const evidence = selectBoardEvidence(start.shipment, seen, now);
  const restored: Shipment = { ...start.shipment, risk: start.baseRisk ?? start.shipment.risk, change: start.baseChange ?? start.shipment.change };
  const binding = thinker.binding(restored, start.mmsi);
  const assess = { ...thinker.assess, session: start.mind ?? null };
  const watched = binding
    ? await watchShipment({ source: binding.source, assess, board: evidence, now: () => now }, restored, binding.key, start.telemetry ?? emptyTelemetryState, start.assessmentCache ?? {})
    : { shipment: restored, state: start.telemetry, cache: start.assessmentCache ?? {}, session: assess.session };
  if (!read) return { messages: [], state: { ...start, shipment: watched.shipment, baseRisk: watched.shipment.risk, baseChange: watched.shipment.change, assessmentCache: watched.cache, telemetry: watched.state, seen, mind: watched.session } };
  const own = start.board?.observed ? `obs:${start.board.observed}` : null;
  const reacted = react(watched.shipment, seen, start.reactions ?? {}, own, now);
  // A manually replaced plan starts a new demo: earlier synthetic exercises must not move its new baseline.
  // Live notices remain eligible regardless of publication time.
  const notices = read.disruptions.filter(notice => !start.shipment.voyage || notice.evidence.source !== 'simulation' || Date.parse(notice.evidence.observedAt) >= Date.parse(start.shipment.voyage.updatedAt));
  const assessed = await assessNotices({ ...assess, session: watched.session }, watched.cache, reacted.shipment, notices, evidence);
  const floor = riskFloor(assessed.shipment.signals ?? [], reacted.summary);
  const modelled = assessed.shipment.change !== restored.change;
  const letGo = !floor && !modelled && (start.floored?.length ?? 0) > 0 ? clearance(assessed.shipment.risk, reacted.heard, start.floored ?? []) : null;
  const shipment: Shipment = {
    ...assessed.shipment, risk: applyFloor(assessed.shipment.risk, floor),
    ...(floor && !modelled ? { change: floorChange(floor, reacted.summary.hours) } : letGo ? { change: clearedChange(letGo) } : {}),
  };
  const memory = start.board ?? emptyBoardMemory;
  const decided = commitDecisions(memory, decideBoard(memory, { shipment, situation: watched.state?.situation ?? null, now, society: { floor: floor ?? letGo, queues: reacted.changed } }));
  return {
    messages: decided.messages,
    state: { ...start, shipment, baseRisk: assessed.shipment.risk, baseChange: assessed.shipment.change, floored: floor?.citedEvidence ?? [], reactions: reacted.reactions, assessmentCache: assessed.cache, mind: assessed.session, telemetry: watched.state, board: decided.memory, seen },
  };
}
