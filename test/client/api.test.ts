import { expect, test } from 'bun:test';
import { dashboardSchema, invitationSchema } from '../../src/client/api';
import { parseDashboardEvent } from '../../src/client/feed';
import { portIds } from '../../src/core/ports';
import { fixtureAssessment, societyDashboard } from './society-fixture';

test('GET and SSE snapshots retain the canonical actor board and port status', () => {
  const decoded = dashboardSchema.parse(societyDashboard);
  expect(decoded.board).toEqual(societyDashboard.board);
  expect(decoded.portStatus).toEqual(societyDashboard.portStatus);
  expect(decoded.shipments).toEqual(societyDashboard.shipments);
  expect(decoded.ports.map(port => port.id)).toEqual([...portIds]);
  const streamed = parseDashboardEvent(JSON.stringify(societyDashboard));
  expect(streamed?.board).toEqual(societyDashboard.board);
  expect(streamed?.portStatus).toEqual(societyDashboard.portStatus);
});

test('missing actor reports remain distinct from explicitly empty reports', () => {
  const { board, portStatus, ...unreported } = societyDashboard;
  expect(dashboardSchema.parse(unreported).board).toBeUndefined();
  expect(dashboardSchema.parse(unreported).portStatus).toBeUndefined();
  expect(dashboardSchema.parse({ ...unreported, board: [], portStatus: [] }).board).toEqual([]);
  expect(dashboardSchema.parse({ ...unreported, board: [], portStatus: [] }).portStatus).toEqual([]);
});

test('relay health survives GET and SSE without inventing a missing transport status', () => {
  const health = { state: 'reconnecting', since: '2026-10-31T12:00:00.000Z', lastPostAt: null } as const;
  const snapshot = { ...societyDashboard, relayHealth: health };
  expect(dashboardSchema.parse(snapshot).relayHealth).toEqual(health);
  expect(parseDashboardEvent(JSON.stringify(snapshot))?.relayHealth).toEqual(health);
  expect(dashboardSchema.parse(societyDashboard).relayHealth).toBeUndefined();
});

test('a post that breaks the assessment law is dropped in GET and SSE; the fleet and the other posts stay', () => {
  const others = societyDashboard.board ?? [];
  const ruleWithInventedConfidence = { ...societyDashboard, board: [...others, { ...fixtureAssessment, id: 'bad:rule', confidence: 0 }] };
  const fallbackWithoutConfidence = { ...societyDashboard, board: [{ ...fixtureAssessment, id: 'bad:fallback', method: 'deterministic-fallback', confidence: null }, ...others] };
  [ruleWithInventedConfidence, fallbackWithoutConfidence].forEach(snapshot => {
    expect(dashboardSchema.parse(snapshot).board).toEqual(others);
    expect(dashboardSchema.parse(snapshot).shipments).toEqual(societyDashboard.shipments);
    expect(parseDashboardEvent(JSON.stringify(snapshot))?.board).toEqual(others);
  });
});

test('invitation receipts cannot fabricate email delivery', () => {
  const link = { email: 'teammate@example.com', url: 'http://localhost:4310/?invite=test' };
  expect(invitationSchema.safeParse({ ...link, delivery: 'link-only' }).success).toBe(true);
  expect(invitationSchema.safeParse({ ...link, delivery: 'accepted', messageId: 'provider-receipt' }).success).toBe(true);
  expect(invitationSchema.safeParse({ ...link, delivery: 'unconfirmed', warning: 'Provider timed out.' }).success).toBe(true);
  expect(invitationSchema.safeParse({ ...link, delivery: 'accepted' }).success).toBe(false);
  expect(invitationSchema.safeParse({ ...link, delivery: 'accepted', messageId: '' }).success).toBe(false);
  expect(invitationSchema.safeParse({ ...link, delivery: 'sent' }).success).toBe(false);
});
