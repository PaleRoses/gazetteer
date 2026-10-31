import type { IntelligenceItem, WarningSeverity } from '../core/types';

const rank: Record<WarningSeverity, number> = { minor: 1, moderate: 2, severe: 3, extreme: 4 };
export const warningTone = (severity: WarningSeverity | undefined): 'red' | 'yellow' | 'unknown' =>
  severity === undefined ? 'unknown' : rank[severity] >= 3 ? 'red' : 'yellow';
export const warningLabel = (severity: WarningSeverity | undefined): string =>
  severity ? severity[0]!.toUpperCase() + severity.slice(1) : 'Severity unknown';

/** A cluster reflects its most severe member, never the average or majority. */
export function highestSeverity(items: readonly IntelligenceItem[]): WarningSeverity | undefined {
  return items.reduce<WarningSeverity | undefined>((highest, item) =>
    item.severity && rank[item.severity] > (highest ? rank[highest] : 0) ? item.severity : highest, undefined);
}
