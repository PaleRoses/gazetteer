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

test('the canonical assessment method governs null confidence in GET and SSE', () => {
  const ruleWithInventedConfidence = { ...societyDashboard, board: [{ ...fixtureAssessment, confidence: 0 }] };
  const aiWithoutConfidence = { ...societyDashboard, board: [{ ...fixtureAssessment, method: 'ai-assessed', confidence: null }] };
  expect(dashboardSchema.safeParse(ruleWithInventedConfidence).success).toBe(false);
  expect(parseDashboardEvent(JSON.stringify(ruleWithInventedConfidence))).toBeUndefined();
  expect(dashboardSchema.safeParse(aiWithoutConfidence).success).toBe(false);
  expect(parseDashboardEvent(JSON.stringify(aiWithoutConfidence))).toBeUndefined();
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
