import { gfwDefaults, isStopped } from '../telemetry/gfw';
import { anchoredMinDwellSeconds } from './constants';
import type { Frame } from './frame';
import type { ZoneRef } from './zones';

type VesselMode = 'approach' | 'anchored' | 'berthed';
export type VesselState = Readonly<{ portId: string; mode: VesselMode; stopped: boolean; pendingSince: number | null; since: number; at: number }>;
export type Counts = { anchored: number; berthed: number; approach: number };
export const emptyCounts = (): Counts => ({ anchored: 0, berthed: 0, approach: 0 });

/**
 * Pure: one vessel's state after one frame. `undefined` means not in the port's area. Stopped/moving is GFW's `_is_stopped` hysteresis
 * (gfw.ts); the outer ring only keeps a membership the vessel already had (GFW's `_is_in_port` entry/exit asymmetry). A frame not newer than the last returns the same object.
 */
export function step(previous: VesselState | undefined, zone: ZoneRef | undefined, frame: Frame): VesselState | undefined {
  const held = previous && zone && previous.portId === zone.portId ? previous : undefined;
  if (held && frame.at <= held.at) return held;
  if (!zone || (zone.kind === 'outer' && !held)) return undefined;
  const stopped = frame.sogKnots === null ? held?.stopped ?? false : isStopped(gfwDefaults, held?.stopped ?? false, frame.sogKnots);
  const pendingSince = stopped && zone.kind === 'anchorage' ? held?.pendingSince ?? frame.at : null;
  const mode: VesselMode = !stopped || zone.kind === 'outer' ? 'approach'
    : zone.kind === 'berth' ? 'berthed'
      : frame.at - (pendingSince ?? frame.at) >= anchoredMinDwellSeconds ? 'anchored' : 'approach';
  return { portId: zone.portId, mode, stopped, pendingSince, since: held?.mode === mode ? held.since : frame.at, at: frame.at };
}

/** Adds or removes one vessel's mode from a port's counters, in place: the hot path allocates nothing. */
export const bump = (counts: Counts, state: VesselState | undefined, by: 1 | -1): void => {
  if (state) counts[state.mode] += by;
};
