import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../../src/core/demo';
import { ports } from '../../../src/core/ports';
import { buildIntelligence, callsAhead } from '../../../src/server/runtime/intelligence';
import type { Notice } from '../../../src/server/sources/notice';
import { dashboardSchema } from '../../../src/client/api';
import { shipmentBrief } from '../../../src/client/brief';

const now = new Date('2026-10-31T12:00:00Z');
const ships = demoShipments(now);
const notice = (override: Partial<Notice> = {}): Notice => ({
  id: 'notice-1', provider: 'nws', kind: 'weather', severity: 'moderate', title: 'Test port weather', detail: 'Recorded test evidence',
  observedAt: now.toISOString(), expiresAt: '2026-11-01T12:00:00Z', fetchedAt: now.toISOString(), provenance: 'live',
  geometry: { kind: 'bbox', west: 101.3, east: 101.4, south: 2.9, north: 3.1 }, url: 'https://weather.gov/test', ...override,
});

describe('voyage intelligence', () => {
  test('an off-route Port Klang notice is visible for Singapore diversion planning without changing ETA or risk', () => {
    const before = JSON.stringify(ships);
    const news = buildIntelligence(ships, [notice()], now);
    const reasons = news.items[0]?.relevance.filter(reason => reason.shipmentId === 'gz-1042');
    expect(reasons?.some(reason => reason.kind === 'diversion')).toBe(true);
    expect(reasons?.some(reason => reason.kind === 'route')).toBe(false);
    expect(news.diversions.find(option => option.id === reasons?.[0]?.diversionId)?.name).toBe('Port Klang');
    expect(JSON.stringify(ships)).toBe(before);
  });
  test('a declared destination-zone notice stays on the planned voyage and unrelated voyages are excluded', () => {
    const news = buildIntelligence(ships, [notice({ geometry: { kind: 'zone', zoneIds: ['test'], portIds: ['los-angeles'] } })], now);
    expect(news.items[0]?.relevance).toEqual(ships.filter(s => s.destination === 'los-angeles').map(s => ({ shipmentId: s.id, kind: 'route', reason: 'Reaches the upcoming Los Angeles call.' })));
  });
  test('passed calls and expired notices do not generate prospective diversion exposure', () => {
    expect(callsAhead(ships[0]!, new Date(now.getTime() + 280 * 3_600_000))).toEqual(['rotterdam']);
    expect(buildIntelligence(ships, [notice({ expiresAt: now.toISOString() })], now).items).toHaveLength(0);
    expect(buildIntelligence(ships, [], new Date(Math.max(...ships.map(ship => Date.parse(ship.eta))) + 3_600_000)).diversions).toHaveLength(0);
  });
  test('shared evidence appears once with both shipment associations, retaining provider failure status', () => {
    const evidence = { id: 'shared', source: 'simulation' as const, title: 'Port queue', detail: 'Test', observedAt: now.toISOString() };
    const news = buildIntelligence(ships.slice(0, 2).map(ship => ({ ...ship, evidence: [evidence] })), [], now, ['gdacs']);
    expect(news.items).toHaveLength(1);
    expect(news.items[0]?.relevance).toHaveLength(2);
    expect(news.unavailableProviders).toEqual(['gdacs']);
  });
  test('assessment provenance and diversion evidence survive the actual client response parser', () => {
    const assessment = { noticeId: 'test', method: 'ai-assessed' as const, model: 'test-model', assessedAt: now.toISOString(), affected: true, delayHours: { low: 12, likely: 24, high: 36 }, confidence: 0.7, rationale: 'Congestion threatens the next berth window.', citedEvidence: ['test'], fallbackReason: null };
    const ship = { ...ships[0]!, risk: 'delayed' as const, assessments: [assessment, { ...assessment, noticeId: 'unaffected', affected: false, rationale: 'An unrelated notice has no effect.' }] };
    const intelligence = buildIntelligence([ship], [notice()], now);
    const parsed = dashboardSchema.parse({ shipments: [ship], ports, intelligence, updatedAt: now.toISOString(), mode: 'mixed', runtime: 'test', relay: 'test' });
    expect(parsed.intelligence?.items).toHaveLength(1);
    expect(parsed.shipments[0]?.assessments).toHaveLength(2);
    expect(shipmentBrief(parsed.shipments[0]!)).toEqual({ text: assessment.rationale, source: 'AI assessment' });
  });
});

test('SSE publishes a news coverage change even if shipment risk is unchanged, without clock-only churn', async () => {
  const { createHub } = await import('../../../src/server/runtime/hub');
  const hub = createHub();
  const intelligence = buildIntelligence(ships, [notice()], now);
  const snapshot = { shipments: ships, ports, intelligence, updatedAt: now.toISOString(), mode: 'mixed' as const, runtime: 'test', relay: 'test' };
  expect(hub.publishDashboard('workspace', snapshot)).toBe(true);
  expect(hub.publishDashboard('workspace', { ...snapshot, intelligence: { ...intelligence, checkedAt: '2026-10-31T12:01:00Z' } })).toBe(false);
  expect(hub.publishDashboard('workspace', { ...snapshot, intelligence: { ...intelligence, unavailableProviders: ['nws'] } })).toBe(true);
});

test('notice severity survives retained evidence merging and client parsing', () => {
  const source = notice({ severity: 'extreme' });
  const ship = { ...ships[0]!, evidence: [{ id: source.id, source: 'live' as const, provider: source.provider, url: source.url, title: source.title, detail: source.detail, observedAt: source.observedAt }] };
  const intelligence = buildIntelligence([ship], [source], now);
  const parsed = dashboardSchema.parse({ shipments: [ship], ports, intelligence, updatedAt: now.toISOString(), mode: 'mixed', runtime: 'test', relay: 'test' });
  expect(parsed.intelligence?.items[0]?.severity).toBe('extreme');
  const legacy = buildIntelligence([ship], [], now);
  expect(legacy.items[0]?.severity).toBeUndefined();
});
