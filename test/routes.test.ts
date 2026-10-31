import { describe, expect, test } from 'bun:test';
import { demoShipments, ports, assessDisruption } from '../src/domain';
import { corridorId, monitoredRoutes } from '../src/routes';
import { buildRouteMonitoring } from '../src/server/routes';
import { dashboardSchema } from '../src/client/api';
import { readView, viewHash } from '../src/client/navigation';
import { createHub } from '../src/server/realtime/sse';
import type { Notice } from '../src/server/sources/notice';

const now = new Date('2026-10-31T12:00:00Z');
const ships = demoShipments(now).filter(s => ['gz-1042', 'gz-1043', 'gz-1044', 'gz-1045'].includes(s.id));
const id = corridorId('singapore', 'rotterdam');
const notice = (overrides: Partial<Notice> = {}): Notice => ({ id: 'test', provider: 'nws', kind: 'weather', severity: 'moderate', title: 'Test weather', detail: 'Fixture', observedAt: now.toISOString(), expiresAt: '2026-11-01T12:00:00Z', fetchedAt: now.toISOString(), provenance: 'live', geometry: { kind: 'zone', zoneIds: ['test'], portIds: ['los-angeles'] }, url: 'https://weather.gov/test', ...overrides });

describe('shared route monitoring', () => {
  test('opposite directions share a stable corridor; via calls belong to each leg, not a fictitious direct route', () => {
    const routes = monitoredRoutes(ships);
    expect(routes).toHaveLength(3);
    expect(routes.find(r => r.id === id)?.shipmentIds).toEqual(['gz-1042', 'gz-1044']);
    expect(routes.find(r => r.id === corridorId('shanghai', 'los-angeles'))?.shipmentIds).toEqual(['gz-1043', 'gz-1045']);
    expect(routes.some(r => r.id === corridorId('shanghai', 'rotterdam'))).toBe(false);
    expect(monitoredRoutes([...ships].reverse()).map(r => r.id)).toEqual(routes.map(r => r.id));
    expect(routes.every(r => r.path.length >= 2)).toBe(true);
  });
  test('multiple cargo shipments on one vessel stay distinct and repeated legs do not double count a shipment', () => {
    const repeat = { ...ships[0]!, via: ['singapore', 'shanghai', 'singapore'] as const };
    const more = { ...ships[0]!, id: 'another-booking' };
    expect(monitoredRoutes([repeat, more]).find(r => r.id === corridorId('shanghai', 'singapore'))?.shipmentIds).toHaveLength(2);
  });
  test('a durable disruption changes the relevant route rollup but leaves the transpacific route unchanged', () => {
    const evidence = { id: 'congestion', source: 'simulation' as const, title: 'Singapore test', detail: 'Fixture', observedAt: now.toISOString() };
    const changed = ships.map(s => assessDisruption(s, { id: evidence.id, portId: 'singapore', delayHours: 36, evidence }));
    const before = JSON.stringify(changed);
    const routes = buildRouteMonitoring(changed, [], now);
    const affected = routes.find(r => r.id === id)!;
    expect(affected).toMatchObject({ risk: 'delayed', attention: 2, maxDelayHours: 36 });
    expect(affected.intelligence?.items).toHaveLength(1);
    expect(affected.intelligence?.items[0]?.relevance.every(r => r.kind === 'context')).toBe(true);
    expect(routes.find(r => r.id === corridorId('shanghai', 'los-angeles'))).toMatchObject({ risk: 'on-track', attention: 0, maxDelayHours: 0 });
    expect(JSON.stringify(changed)).toBe(before);
  });
  test('full corridor coverage includes both endpoints, excludes unrelated corridors, and does not assign risk from unassessed news', () => {
    const routes = buildRouteMonitoring(ships, [notice()], now, ['gdacs']);
    const pacific = routes.find(r => r.id === corridorId('shanghai', 'los-angeles'))!;
    expect(pacific.intelligence?.items).toHaveLength(1);
    expect(pacific.intelligence?.items[0]?.relevance.some(r => r.kind === 'route')).toBe(true);
    expect(pacific.risk).toBe('on-track');
    expect(pacific.intelligence?.unavailableProviders).toEqual(['gdacs']);
    expect(routes.find(r => r.id === id)?.intelligence?.items).toHaveLength(0);
  });
  test('a corridor includes its origin endpoint even without a reverse-direction voyage', () => {
    const routes = buildRouteMonitoring([ships[0]!], [notice({ geometry: { kind: 'zone', zoneIds: ['shanghai'], portIds: ['shanghai'] } })], now);
    expect(routes.find(r => r.id === corridorId('shanghai', 'singapore'))?.intelligence?.items[0]?.relevance[0]?.kind).toBe('route');
    expect(routes.find(r => r.id === id)?.intelligence?.items).toHaveLength(0);
  });
  test('diversion-specific news is retained without claiming corridor disruption; expired news is excluded', () => {
    const diversion = notice({ geometry: { kind: 'bbox', west: 101.3, east: 101.4, south: 2.9, north: 3.1 } });
    const route = buildRouteMonitoring(ships, [diversion], now).find(r => r.id === id)!;
    expect(route.intelligence?.items[0]?.relevance.some(r => r.kind === 'diversion')).toBe(true);
    expect(route.intelligence?.items[0]?.relevance.some(r => r.kind === 'route')).toBe(false);
    expect(buildRouteMonitoring(ships, [{ ...diversion, expiresAt: now.toISOString() }], now).find(r => r.id === id)?.intelligence?.items).toHaveLength(0);
  });
  test('routes survive the API schema and stream only meaningful updates', () => {
    const routes = buildRouteMonitoring(ships, [], now);
    const snapshot = dashboardSchema.parse({ routes, shipments: ships, ports, updatedAt: now.toISOString(), mode: 'mixed', runtime: 'test', relay: 'test', startup: { ready: 4, total: 8, queued: 1 } });
    expect(snapshot.routes).toEqual(routes);
    expect(snapshot.startup?.queued).toBe(1);
    const hub = createHub();
    expect(hub.publishDashboard('workspace', snapshot)).toBe(true);
    expect(hub.publishDashboard('workspace', { ...snapshot, routes: snapshot.routes!.map(r => ({ ...r, intelligence: { ...r.intelligence!, checkedAt: '2026-10-31T12:01:00Z' } })) })).toBe(false);
    expect(hub.publishDashboard('workspace', { ...snapshot, routes: buildRouteMonitoring(ships, [notice()], now) })).toBe(true);
  });
});

describe('workspace-scoped route navigation', () => {
  test('route drilldowns and route overview survive reload and browser navigation', () => {
    for (const view of [{ kind: 'route', id }, { kind: 'voyage', id: 'gz-1042' }, { kind: 'routes' }, { kind: 'shipments' }] as const) expect(readView(viewHash(view, 'workspace-a'), 'workspace-a')).toEqual(view);
  });
  test('foreign workspace, malformed and partial links cannot open a stale briefing', () => {
    for (const hash of ['#route/other/route', '#route/workspace-a', '#route/%ZZ/a', '#voyage/workspace-a/a/extra']) expect(readView(hash, 'workspace-a')).toEqual({ kind: 'shipments' });
  });
});
