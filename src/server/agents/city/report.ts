import type { CityElement, CityReport, PortRisk } from '../../../core/board';
import type { PortId } from '../../../core/ports';

/** A warning that is not re-said looks stale: while the risk is not normal, a watch says it again after this long even if nothing moved. */
export const repostHours = 6;

const sequence = (report: CityReport | null): number => Number(report?.id.match(/#(\d+)$/)?.[1] ?? 0);

/**
 * The previous report's sequence plus one: a retry after a failed post carries the same id and Relay dedupes it, while a later
 * return to an earlier state, or a heartbeat, is a new message.
 */
export const reportId = (city: PortId, element: CityElement, previous: CityReport | null): string => `${element}:${city}#${sequence(previous) + 1}`;

export const heartbeat = (previous: CityReport | null, risk: PortRisk, now: Date): boolean =>
  previous !== null && risk !== 'normal' && now.getTime() - Date.parse(previous.at) >= repostHours * 3_600_000;

export const clip = (text: string): string => text.length <= 280 ? text : `${text.slice(0, 279)}…`;

export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;
