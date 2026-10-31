import { highestSeverity } from './warning-severity';
import type { IntelligenceItem, WarningSeverity } from '../core/types';

export type ScreenPoint = Readonly<{ x: number; y: number }>;
export type WarningCluster = Readonly<{ id: string; items: readonly IntelligenceItem[]; center: ScreenPoint; severity: WarningSeverity | undefined }>;

/** Group overlapping pins in screen pixels, so zooming naturally separates them. */
export function clusterWarnings(items: readonly IntelligenceItem[], project: (coordinates: readonly [number, number]) => ScreenPoint, radius = 44): readonly WarningCluster[] {
  const unique = [...new Map(items.filter(item => item.coordinates).map(item => [item.evidence.id, item])).values()]
    .sort((a, b) => a.evidence.id.localeCompare(b.evidence.id));
  const points = unique.map(item => project(item.coordinates!));
  const parents = unique.map((_, index) => index);
  const root = (index: number): number => {
    while (parents[index] !== index) { parents[index] = parents[parents[index]!]!; index = parents[index]!; }
    return index;
  };
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (Math.hypot(points[i]!.x - points[j]!.x, points[i]!.y - points[j]!.y) <= radius) parents[root(j)] = root(i);
  }
  const groups = new Map<number, number[]>();
  unique.forEach((_, index) => { const key = root(index); groups.set(key, [...(groups.get(key) ?? []), index]); });
  return [...groups.values()].map(indices => ({
    id: JSON.stringify(indices.map(index => unique[index]!.evidence.id)),
    items: indices.map(index => unique[index]!),
    severity: highestSeverity(indices.map(index => unique[index]!)),
    center: { x: indices.reduce((sum, index) => sum + points[index]!.x, 0) / indices.length, y: indices.reduce((sum, index) => sum + points[index]!.y, 0) / indices.length },
  }));
}
