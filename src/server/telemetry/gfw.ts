/*
 * Vessel-event definitions ported from Global Fishing Watch pipelines, Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0).
 * Ported from Python to TypeScript (state carried explicitly instead of a Beam pipeline); the thresholds and state machines are theirs.
 *
 *   pipe-anchorages  Copyright 2017 Global Fishing Watch   github.com/GlobalFishingWatch/pipe-anchorages @ 5761629568b86202ee010388d6a5ae9ce172a21d
 *     src/pipe_anchorages/cli/commands/port_state_transitions.py  defaults: entry 3.0 km, exit 4.0 km, stopping 0.2 kn, starting 0.5 kn
 *     src/pipe_anchorages/transforms/in_out_events.py             InOutEventsBase: states AT_SEA / IN_PORT / STOPPED, _is_in_port / _is_stopped hysteresis, transition_map
 *   pipe-loitering   Copyright 2021 Global Fishing Watch   github.com/GlobalFishingWatch/pipe-loitering @ 71980b77a46cec40b623557c2a2be0d1a4d0388d
 *     src/pipe_loitering/cli/commands/create_raw_loitering.py     --slow-threshold default 2 kn
 *     src/pipe_loitering/create_raw_loitering/transforms/calculate_hourly_stats.py, group_loitering_ranges.py   hourly buckets, slow runs
 *   pipe-gaps        github.com/GlobalFishingWatch/pipe-gaps @ c8ab3cc6c9799721110116434e4bb850860be2e3
 *     src/pipe_gaps/core/gap_detector.py                          GapDetector.THRESHOLD 12 h, _gap_condition (strictly greater); README "Definition of intentional disabling event"
 *
 * Not GFW: the vessel's position against the planned route and the speed the ETA needs (see watcher.ts).
 */
import { distanceKm } from '../../sea-routes';
import type { LonLat } from './telemetry';

export const gfwDefaults = {
  anchorageEntryKm: 3.0, anchorageExitKm: 4.0, stoppingKnots: 0.2, startingKnots: 0.5, slowKnots: 2, gapHours: 12,
} as const;

export type PortState = 'AT_SEA' | 'IN_PORT' | 'STOPPED';
export type PortEvent = 'PORT_ENTRY' | 'PORT_EXIT' | 'PORT_STOP_BEGIN' | 'PORT_STOP_END';
const inPortStates: readonly PortState[] = ['IN_PORT', 'STOPPED'];

/** InOutEventsBase.transition_map, verbatim. */
const transitions: Readonly<Record<PortState, Readonly<Record<PortState, readonly PortEvent[]>>>> = {
  AT_SEA: { AT_SEA: [], IN_PORT: ['PORT_ENTRY'], STOPPED: ['PORT_ENTRY', 'PORT_STOP_BEGIN'] },
  IN_PORT: { AT_SEA: ['PORT_EXIT'], IN_PORT: [], STOPPED: ['PORT_STOP_BEGIN'] },
  STOPPED: { AT_SEA: ['PORT_STOP_END', 'PORT_EXIT'], IN_PORT: ['PORT_STOP_END'], STOPPED: [] },
};

export type GfwParameters = Readonly<{
  anchorageEntryKm: number; anchorageExitKm: number; stoppingKnots: number; startingKnots: number; slowKnots: number; gapHours: number;
}>;

/** _is_in_port: inside the entry distance is in, beyond the exit distance is out, between keeps the previous answer. `null` distance is out. */
export const isInPort = (parameters: GfwParameters, previousInPort: boolean, distance: number | null): boolean =>
  distance === null ? false : distance <= parameters.anchorageEntryKm ? true : distance >= parameters.anchorageExitKm ? false : previousInPort;

/** _is_stopped: at or under the stopping speed is stopped, at or over the starting speed is moving, between keeps the previous answer. */
export const isStopped = (parameters: GfwParameters, previousStopped: boolean, speedKnots: number): boolean =>
  speedKnots <= parameters.stoppingKnots ? true : speedKnots >= parameters.startingKnots ? false : previousStopped;

export const portStateOf = (inPort: boolean, stopped: boolean): PortState => inPort ? (stopped ? 'STOPPED' : 'IN_PORT') : 'AT_SEA';
export const portEvents = (from: PortState | null, to: PortState): readonly PortEvent[] => from === null ? [] : transitions[from][to];
export const isInPortState = (state: PortState): boolean => inPortStates.includes(state);

/** GapDetector._gap_condition: a gap is a silence strictly longer than the threshold; an open gap is the time elapsed since the last position. */
export const isOpenGap = (parameters: GfwParameters, silentHours: number): boolean => silentHours > parameters.gapHours;

export type Fix = Readonly<{ at: string; position: LonLat }>;
export type Track = Readonly<{ inPort: boolean; stopped: boolean; state: PortState | null; lastEvents: readonly PortEvent[]; fixes: readonly Fix[] }>;
export const emptyTrack: Track = { inPort: false, stopped: false, state: null, lastEvents: [], fixes: [] };
const retainHours = 48;
const maxFixes = 300;

export type TrackInput = Readonly<{ at: string; position: LonLat; sogKnots: number | null; nearestPortKm: number | null }>;

/** Advances the hysteresis state by one new fix. A fix not newer than the last one changes nothing, so an alarm re-reading a stale position is a no-op. */
export function advanceTrack(parameters: GfwParameters, track: Track, fix: TrackInput): Track {
  const last = track.fixes[track.fixes.length - 1];
  if (last && Date.parse(fix.at) <= Date.parse(last.at)) return track;
  const inPort = isInPort(parameters, track.inPort, fix.nearestPortKm);
  const stopped = fix.sogKnots === null ? track.stopped : isStopped(parameters, track.stopped, fix.sogKnots);
  const state = portStateOf(inPort, stopped);
  const horizon = Date.parse(fix.at) - retainHours * 3_600_000;
  return {
    inPort, stopped, state, lastEvents: portEvents(track.state, state),
    fixes: [...track.fixes, { at: fix.at, position: fix.position }].filter(item => Date.parse(item.at) >= horizon).slice(-maxFixes),
  };
}

type Bucket = Readonly<{ hour: string; hours: number; meters: number }>;

/** calculate_hourly_stats: per UTC hour, the time elapsed since each previous fix and the distance travelled to it; slow when their ratio is under the slow threshold. */
const hourlyBuckets = (fixes: readonly Fix[]): readonly Bucket[] =>
  fixes.slice(1).reduce<readonly Bucket[]>((buckets, fix, index) => {
    const previous = fixes[index]!;
    const hour = fix.at.slice(0, 13);
    const hours = (Date.parse(fix.at) - Date.parse(previous.at)) / 3_600_000;
    const meters = distanceKm(previous.position, fix.position) * 1000;
    const tail = buckets[buckets.length - 1];
    return tail && tail.hour === hour ? [...buckets.slice(0, -1), { hour, hours: tail.hours + hours, meters: tail.meters + meters }] : [...buckets, { hour, hours, meters }];
  }, []);

const bucketKnots = (bucket: Bucket): number | null => bucket.hours > 0 ? bucket.meters / bucket.hours / 1852 : null;

export type Loitering = Readonly<{ hours: number; avgKnots: number }>;

/** group_loitering_ranges: the run of consecutive slow hourly buckets that ends at the latest fix; null when the vessel is not in one. */
export function currentLoitering(parameters: GfwParameters, fixes: readonly Fix[]): Loitering | null {
  const buckets = hourlyBuckets(fixes);
  const slow = (bucket: Bucket): boolean => { const knots = bucketKnots(bucket); return knots !== null && knots < parameters.slowKnots; };
  const run = buckets.reduceRight<Readonly<{ open: boolean; members: readonly Bucket[] }>>((state, bucket) =>
    state.open && slow(bucket) ? { open: true, members: [bucket, ...state.members] } : { ...state, open: false }, { open: true, members: [] }).members;
  const hours = run.reduce((sum, bucket) => sum + bucket.hours, 0);
  return run.length === 0 || hours === 0 ? null : { hours, avgKnots: run.reduce((sum, bucket) => sum + bucket.meters, 0) / hours / 1852 };
}
