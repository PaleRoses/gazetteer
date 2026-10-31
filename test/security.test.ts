import { expect, test } from 'bun:test';
import { demoShipments, ports } from '../src/domain';
import { buildIntelligence } from '../src/server/intelligence';
import { buildRouteMonitoring } from '../src/server/routes';
import { securityReports, securityReviewedAt } from '../src/server/sources/security';
import { dashboardSchema } from '../src/client/api';
import { feeds } from '../src/server/sources';

const now = new Date('2026-10-31T12:00:00Z');
const ships = demoShipments(now);
const reports = securityReports(now);

test('dated security news and advisories survive the client schema without advancing publication dates', () => {
  const intelligence = buildIntelligence(ships, reports, now);
  const parsed = dashboardSchema.parse({ shipments: ships, ports, intelligence, updatedAt: now.toISOString(), mode: 'mixed', runtime: 'test', relay: 'test' });
  expect(parsed.intelligence?.items).toHaveLength(4);
  const evidence = parsed.intelligence!.items[0]!.evidence;
  expect(evidence.observedAt).toBe('2026-10-30T21:10:00Z');
  expect(evidence.source === 'live' && evidence.report?.reviewedAt).toBe(securityReviewedAt);
  expect(reports.find(report => report.id.endsWith('2026-013'))?.report?.validUntil).toBe('2027-03-22');
});

test('Hormuz warnings match the new Gulf voyage and disappear when that voyage is absent', () => {
  const before = JSON.stringify(ships);
  const intelligence = buildIntelligence(ships, reports, now);
  expect(intelligence.items.find(item => item.evidence.id.endsWith(':hormuz'))?.relevance.map(r => r.shipmentId)).toEqual(['gz-1053']);
  expect(buildIntelligence(ships.filter(ship => ship.id !== 'gz-1053'), reports, now).items.some(item => item.evidence.id.endsWith(':hormuz'))).toBe(false);
  expect(intelligence.items.find(item => item.evidence.id.endsWith('2026-013'))?.relevance.some(r => r.kind === 'route')).toBe(true);
  expect(intelligence.items.find(item => item.evidence.id.endsWith(':aden'))?.relevance.every(r => r.kind === 'context')).toBe(true);
  expect(JSON.stringify(ships)).toBe(before);
});

test('Pacific corridors do not inherit unrelated maritime security stories', () => {
  const routes = buildRouteMonitoring(ships, reports, now);
  const pacific = routes.filter(route => route.endpoints.includes('los-angeles'));
  expect(pacific.length).toBeGreaterThan(0);
  expect(pacific.every(route => route.intelligence?.items.length === 0)).toBe(true);
});

test('curated reports expire rather than looking freshly polled forever and never enter automatic disruption feeds', () => {
  expect(securityReports(new Date('2026-09-01T00:00:00Z'))).toEqual([]);
  expect(securityReports(new Date('2026-11-07T00:00:00Z'))).toEqual([]);
  expect(feeds.some(feed => feed.provider === 'ap' || feed.provider === 'marad')).toBe(false);
});


test('Jebel Ali–Singapore is a monitored sea corridor through Hormuz, with source-linked warnings', () => {
  const gulf = ships.find(ship => ship.id === 'gz-1053')!;
  expect(gulf.origin).toBe('jebel-ali');
  expect(gulf.destination).toBe('singapore');
  expect(gulf.route.some(([lon, lat]) => lon > 55.8 && lon < 57.2 && lat > 25.5 && lat < 27)).toBe(true);
  const route = buildRouteMonitoring(ships, reports, now).find(route => route.endpoints.includes('jebel-ali'))!;
  expect(route.shipmentIds).toEqual([gulf.id]);
  expect(route.intelligence?.items.some(item => item.evidence.id.endsWith(':hormuz'))).toBe(true);
  expect(route.intelligence?.items.some(item => item.evidence.id.endsWith(':aden'))).toBe(false);
  expect(route.intelligence?.items.find(item => item.evidence.id.endsWith('2026-011'))?.relevance[0]?.kind).toBe('route');
});
