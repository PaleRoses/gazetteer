import type { Risk } from '../../../core/types';
import type { Signal } from '../../telemetry/watcher';
import { worse } from '../../assessment/apply';

/** Declared, not tuned. A ship stopped outside a port for half a day, or one whose current speed misses its ETA by a day, is delayed whatever any model says. */
export const floorRules = {
  loiteringHours: { value: 12, basis: 'half a day stopped in the approach: the same length as the AIS gap threshold the watcher takes from Global Fishing Watch' },
  projectedSlipHours: { value: 24, basis: 'a full day of slip at the current speed over ground' },
  reactionDelayedHours: { value: 24, basis: 'a queue delay of a full day or more' },
} as const;

/** What the ship's reaction layer concluded from the board this cycle: bulletins it must keep an eye on, and the queue delay it has applied. */
export type ReactionSummary = Readonly<{ watching: readonly string[]; hours: number }>;
export const noReaction: ReactionSummary = { watching: [], hours: 0 };

export type RiskFloor = Readonly<{ risk: Exclude<Risk, 'on-track'>; method: 'rule-based'; reasons: readonly string[]; citedEvidence: readonly string[] }>;

const measuredHours = (signal: Signal, key: string): number | null => {
  const value = signal.measured[key];
  return typeof value === 'number' ? value : null;
};

const delaying = (signal: Signal): boolean =>
  signal.kind === 'stationary-outside-port' ? (measuredHours(signal, 'loiteringHours') ?? 0) >= floorRules.loiteringHours.value
    : signal.kind === 'slow-steaming' ? (measuredHours(signal, 'projectedSlipHours') ?? 0) > floorRules.projectedSlipHours.value
      : false;

/** Pure and total: the least a rule-based watcher will say. Any active signal is at least a watch; a measured stop or slip past its rule, or a queue delay of a day, is delayed. It never touches the ETA. */
export function riskFloor(signals: readonly Signal[], reaction: ReactionSummary = noReaction): RiskFloor | null {
  const watched = signals.length > 0 || reaction.watching.length > 0 || reaction.hours > 0;
  if (!watched) return null;
  const risk: RiskFloor['risk'] = signals.some(delaying) || reaction.hours >= floorRules.reactionDelayedHours.value ? 'delayed' : 'watch';
  return {
    risk, method: 'rule-based',
    reasons: [
      ...signals.map(signal => signal.title),
      ...(reaction.hours > 0 ? ['a queue ahead delays a call'] : reaction.watching.length ? ['a port ahead is elevated'] : []),
    ],
    citedEvidence: [...new Set([...signals.map(signal => signal.id), ...reaction.watching])],
  };
}

/** The ship's risk is the worse of what it was assessed at and what the rules floor it to. */
export const applyFloor = (base: Risk, floor: RiskFloor | null): Risk => floor ? worse(base, floor.risk) : base;

/** The ship's own words for a risk the rules set and no model assessed. */
export const floorChange = (floor: RiskFloor, queueHours: number): string =>
  queueHours > 0
    ? `Rule-based ${floor.risk}: ${floor.reasons.join('; ')}. The arrival estimate carries the queue delay; no model assessment.`
    : `Rule-based ${floor.risk}: ${floor.reasons.join('; ')}. No model assessment; arrival estimate unchanged.`;
