import { describe, expect, test } from 'bun:test';
import { demoShipments, ports } from '../domain';
import type { Dashboard } from '../shared';
import { changesBetween, isCurrent, mergeComment, parseCommentEvent, parseDashboardEvent } from './feed';

const dashboard = (updatedAt: string, patch: (shipments: ReturnType<typeof demoShipments>) => ReturnType<typeof demoShipments> = value => value): Dashboard =>
  ({ shipments: patch(demoShipments(new Date('2026-10-31T12:00:00Z'))), ports, updatedAt, mode: 'simulation', runtime: 'test', relay: 'test' });

describe('stream payloads', () => {
  test('a dashboard event round-trips and garbage is ignored', () => {
    const snapshot = dashboard('2026-10-31T12:00:00.000Z');
    expect(parseDashboardEvent(JSON.stringify(snapshot))?.shipments.length).toBe(snapshot.shipments.length);
    expect(parseDashboardEvent('{"shipments":[]}')).toBeUndefined();
    expect(parseDashboardEvent('not json')).toBeUndefined();
    expect(parseDashboardEvent(undefined)).toBeUndefined();
  });

  test('a comment event needs a shipment and a comment', () => {
    const comment = { id: 'c1', author: 'Alex', body: 'Called the broker.', createdAt: '2026-10-31T12:01:00.000Z' };
    expect(parseCommentEvent(JSON.stringify({ shipmentId: 'gz-1042', comment }))).toEqual({ shipmentId: 'gz-1042', comment });
    expect(parseCommentEvent(JSON.stringify({ comment }))).toBeUndefined();
    expect(parseCommentEvent(JSON.stringify({ shipmentId: 'gz-1042', comment: { id: 'c1' } }))).toBeUndefined();
  });
});

describe('ordering and merging', () => {
  test('an older snapshot never replaces a newer one', () => {
    const held = dashboard('2026-10-31T12:00:05.000Z');
    expect(isCurrent(held, dashboard('2026-10-31T12:00:00.000Z'))).toBe(false);
    expect(isCurrent(held, dashboard('2026-10-31T12:00:05.000Z'))).toBe(true);
    expect(isCurrent(held, dashboard('2026-10-31T12:00:09.000Z'))).toBe(true);
    expect(isCurrent(null, held)).toBe(true);
  });

  test('a comment seen twice is kept once, in arrival order', () => {
    const first = { id: 'a', author: 'A', body: 'one', createdAt: '2026-10-31T12:00:00.000Z' };
    const second = { id: 'b', author: 'B', body: 'two', createdAt: '2026-10-31T12:00:01.000Z' };
    expect(mergeComment(mergeComment([first], second), second)).toEqual([first, second]);
  });
});

describe('what changed', () => {
  test('reports only shipments whose ETA or risk moved', () => {
    const before = dashboard('2026-10-31T12:00:00.000Z');
    const after = dashboard('2026-10-31T12:01:00.000Z', shipments => shipments.map(shipment => shipment.id === 'gz-1042' ? { ...shipment, eta: '2026-12-01T00:00:00.000Z', risk: 'delayed' as const } : shipment));
    expect(changesBetween(before, after).map(change => `${change.id}:${change.kind}`).sort()).toEqual(['gz-1042:eta', 'gz-1042:risk']);
    expect(changesBetween(before, before)).toEqual([]);
    const drifted = dashboard('2026-10-31T12:01:00.000Z', shipments => shipments.map(shipment => ({ ...shipment, eta: new Date(Date.parse(shipment.eta) + 900).toISOString() })));
    expect(changesBetween(before, drifted)).toEqual([]);
    expect(changesBetween(null, after)).toEqual([]);
  });
});
