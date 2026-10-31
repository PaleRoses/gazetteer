import { expect, test } from 'bun:test';
import { clusterWarnings } from './warning-clusters';
import type { IntelligenceItem } from '../shared';

const item = (id: string, x: number, y: number): IntelligenceItem => ({ coordinates: [x, y], relevance: [], evidence: { id, title: id, detail: 'Fixture', observedAt: '2026-10-31T00:00:00Z', source: 'simulation' } });
const project = ([x, y]: readonly [number, number]) => ({ x, y });

test('nearby warnings merge into one counted group and separate as map scale increases', () => {
  const warnings = [item('a', 10, 10), item('b', 30, 20), item('c', 150, 100)];
  const zoomedOut = clusterWarnings(warnings, project);
  expect(zoomedOut.map(group => group.items.length)).toEqual([2, 1]);
  expect(zoomedOut[0]?.center).toEqual({ x: 20, y: 15 });
  const zoomedIn = clusterWarnings(warnings, ([x, y]) => ({ x: x * 10, y: y * 10 }));
  expect(zoomedIn.map(group => group.items.length)).toEqual([1, 1, 1]);
});

test('groups are stable across feed reorder, preserve every unique warning and exclude unlocated ones', () => {
  const warnings = [item('c', 100, 0), item('b', 20, 0), item('a', 0, 0)];
  expect(clusterWarnings(warnings, project)).toEqual(clusterWarnings([...warnings].reverse(), project));
  const groups = clusterWarnings([...warnings, warnings[0]!, { ...item('unlocated', 0, 0), coordinates: null }], project);
  expect(groups.flatMap(group => group.items).map(item => item.evidence.id).sort()).toEqual(['a', 'b', 'c']);
});

test('overlapping chains form one group, while co-located reports remain accessible at any zoom', () => {
  expect(clusterWarnings([item('a', 0, 0), item('b', 40, 0), item('c', 80, 0)], project)).toHaveLength(1);
  const coincident = clusterWarnings([item('a', 0, 0), item('b', 0, 0)], project);
  expect(coincident[0]?.items).toHaveLength(2);
  expect(clusterWarnings([], project)).toEqual([]);
});
