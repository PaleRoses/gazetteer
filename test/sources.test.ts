import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { demoShipments, ports } from '../src/domain';
import { evidenceLine, exposure, isActive, radiusKm, type Lane, type Place } from '../src/server/sources/exposure';
import { fetchGdacs, gdacsUrl, normalizeGdacs } from '../src/server/sources/gdacs';
import { fetchNws, normalizeNws } from '../src/server/sources/nws';
import { fetchUsgs, normalizeUsgs, usgsSeverity } from '../src/server/sources/usgs';
import { noticesForPort, pollPort, sweep, type Feed } from '../src/server/sources';
import { circleOf, toDisruption } from '../src/server/sources/disruption';
import type { Notice, NoticeGeometry, NoticeKind } from '../src/server/sources/notice';

const fixture = (name: string): unknown => JSON.parse(readFileSync(resolve(import.meta.dir, 'fixtures/sources', name), 'utf8'));
const gdacsRaw = fixture('gdacs-events.json') as { features: readonly { properties: Record<string, unknown> }[] };
const usgsRaw = fixture('usgs-4.5-week.json') as { features: readonly { properties: Record<string, unknown> }[] };
const nwsRaw = fixture('nws-alerts-la.json') as { features: readonly { properties: Record<string, unknown> }[] };
const fetchedAt = '2026-10-31T20:00:00.000Z';
const places: readonly Place[] = ports.map(port => ({ id: port.id, name: port.name, coordinates: port.coordinates }));
const lanes: readonly Lane[] = demoShipments(new Date(fetchedAt)).map(shipment => ({ id: shipment.id, path: shipment.route }));
const gdacs = normalizeGdacs(gdacsRaw, fetchedAt);
const byId = (notices: readonly Notice[], id: string): Notice => {
  const found = notices.find(notice => notice.id === id);
  if (found === undefined) throw new Error(`fixture lacks ${id}`);
  return found;
};
const champiId = (notices: readonly Notice[]): string => notices.find(notice => notice.title.includes('CHAMPI-26'))?.id ?? 'missing-champi';
const synthetic = (kind: NoticeKind, geometry: NoticeGeometry, overrides: Partial<Notice> = {}): Notice => ({
  id: `test:${kind}`, provider: 'gdacs', kind, severity: 'moderate', title: kind, detail: '', observedAt: fetchedAt,
  expiresAt: null, geometry, url: 'https://example.invalid', fetchedAt, provenance: 'live', ...overrides,
});
const pointAt = (lon: number, lat: number): NoticeGeometry => ({ kind: 'point', coordinates: [lon, lat] });
const answering = (body: unknown, status = 200): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('GDACS normalizer on the recorded feed', () => {
  test('keeps the provider id as the idempotency key and labels provenance live', () => {
    const arnab = byId(gdacs, 'gdacs:TC:1001345');
    expect(arnab).toMatchObject({ provider: 'gdacs', kind: 'cyclone', severity: 'severe', provenance: 'live', title: 'Tropical Cyclone ARNAB-26', fetchedAt });
    expect(arnab.geometry).toEqual({ kind: 'point', coordinates: [81.8, 16.4] });
    expect(new Set(gdacs.map(notice => notice.id)).size).toBe(gdacs.length);
  });

  test('a feed-current event is open-ended and an ended one expires at its last date', () => {
    expect(byId(gdacs, 'gdacs:TC:1001343').expiresAt).toBeNull();
    expect(byId(gdacs, champiId(gdacs)).expiresAt).toBe('2026-10-25T18:00:00Z');
  });

  test('a malformed feature is dropped without discarding its neighbours', () => {
    const broken = { ...gdacsRaw, features: [{ properties: { eventtype: 'TC' } }, ...gdacsRaw.features] };
    expect(normalizeGdacs(broken, fetchedAt)).toEqual(gdacs);
  });

  test('an unrecognised envelope yields nothing rather than guesses', () => {
    expect(normalizeGdacs({ message: 'Eventtype is required.' }, fetchedAt)).toEqual([]);
  });
});

describe('USGS normalizer on the recorded feed', () => {
  const usgs = normalizeUsgs(usgsRaw, fetchedAt);
  test('maps a known earthquake with its magnitude, place and epicentre', () => {
    expect(byId(usgs, 'usgs:us7000tuk4')).toMatchObject({
      kind: 'earthquake', severity: 'minor', provenance: 'live', title: 'M 4.5 earthquake · 111 km ESE of Atka, Alaska',
      geometry: { kind: 'point', coordinates: [-172.7931, 51.6994] }, observedAt: '2026-10-31T18:51:02.721Z',
    });
  });
  test('magnitude bands and the tsunami flag set severity', () => {
    expect([usgsSeverity(5.4, false), usgsSeverity(5.5, false), usgsSeverity(6.5, false), usgsSeverity(7.5, false)]).toEqual(['minor', 'moderate', 'severe', 'extreme']);
    expect(usgsSeverity(4.6, true)).toBe('moderate');
    expect(usgsSeverity(7.8, true)).toBe('extreme');
  });
  test('quarry blasts and other non-earthquakes are not notices', () => {
    const quarry = { ...usgsRaw, features: usgsRaw.features.map(feature => ({ ...feature, properties: { ...feature.properties, type: 'quarry blast' } })) };
    expect(normalizeUsgs(quarry, fetchedAt)).toEqual([]);
  });
});

describe('NWS normalizer on the recorded Los Angeles zone alerts', () => {
  const nws = normalizeNws(nwsRaw, fetchedAt);
  test('a zone-only alert is bound to the port whose declared zone it names', () => {
    expect(nws).toHaveLength(nwsRaw.features.length);
    expect(nws[0]).toMatchObject({ provider: 'nws', kind: 'weather', severity: 'minor', provenance: 'live', geometry: { kind: 'zone', zoneIds: ['PZZ655'], portIds: ['los-angeles'] } });
    expect(nws[0]?.expiresAt).toBe(new Date(String(nwsRaw.features[0]?.properties.expires)).toISOString());
  });
  test('test and exercise messages are not notices', () => {
    const exercise = { ...nwsRaw, features: nwsRaw.features.map(feature => ({ ...feature, properties: { ...feature.properties, status: 'Test' } })) };
    expect(normalizeNws(exercise, fetchedAt)).toEqual([]);
  });
  test('an alert naming only zones we have not declared is dropped, never pinned to a port', () => {
    const elsewhere = { ...nwsRaw, features: nwsRaw.features.map(feature => ({ ...feature, properties: { ...feature.properties, geocode: { UGC: ['PZZ745'] } } })) };
    expect(normalizeNws(elsewhere, fetchedAt)).toEqual([]);
  });
  test('a polygon alert becomes a bounding box', () => {
    const polygon = { ...nwsRaw, features: nwsRaw.features.map(feature => ({ ...feature, geometry: { type: 'Polygon', coordinates: [[[-119, 33], [-118, 33], [-118, 34], [-119, 34], [-119, 33]]] } })) };
    expect(normalizeNws(polygon, fetchedAt)[0]?.geometry).toEqual({ kind: 'bbox', west: -119, south: 33, east: -118, north: 34 });
  });
});

describe('exposure', () => {
  test('hand-checked: one degree of latitude is 111.2 km, so 5 degrees north is inside a cyclone and 5.5 degrees is outside', () => {
    expect(radiusKm.cyclone).toBe(600);
    const inside = exposure(synthetic('cyclone', pointAt(4.48, 51.92 + 5)), places, []).ports;
    expect(inside.map(hit => hit.portId)).toEqual(['rotterdam']);
    expect(inside[0]?.distanceKm).toBeCloseTo(556, 0);
    expect(exposure(synthetic('cyclone', pointAt(4.48, 51.92 + 5.5)), places, []).ports).toEqual([]);
  });
  test('the same offset is outside a flood, whose declared reach is shorter', () => {
    expect(exposure(synthetic('flood', pointAt(4.48, 51.92 + 2)), places, []).ports).toEqual([]);
    expect(exposure(synthetic('flood', pointAt(4.48, 51.92 + 1)), places, []).ports.map(hit => hit.portId)).toEqual(['rotterdam']);
  });
  test('a bbox containing the port is at distance zero', () => {
    const hit = exposure(synthetic('volcano', { kind: 'bbox', west: 103, south: 1, east: 105, north: 2 }), places, []).ports;
    expect(hit).toMatchObject([{ portId: 'singapore', distanceKm: 0 }]);
  });
  test('a zone notice reaches only its declared ports and never a lane', () => {
    const found = exposure(synthetic('weather', { kind: 'zone', zoneIds: ['PZZ655'], portIds: ['los-angeles'] }), places, lanes);
    expect(found.ports).toMatchObject([{ portId: 'los-angeles', basis: 'declared-zone' }]);
    expect(found.lanes).toEqual([]);
    expect(evidenceLine(found.ports[0]!, 'Los Angeles')).toContain('declared forecast zone');
  });
  test('a lane that crosses the antimeridian is reached from either side of it', () => {
    const west = exposure(synthetic('cyclone', pointAt(178, 31)), places, lanes).lanes;
    const east = exposure(synthetic('cyclone', pointAt(-178, 31)), places, lanes).lanes;
    expect(west.find(hit => hit.laneId === 'gz-1045')).toMatchObject({ segment: 3 });
    expect(east.find(hit => hit.laneId === 'gz-1045')).toMatchObject({ segment: 2 });
    expect(east.find(hit => hit.laneId === 'gz-1045')?.distanceKm).toBeCloseTo(111, -1);
    expect(exposure(synthetic('cyclone', pointAt(0, 31)), places, lanes).lanes.find(hit => hit.laneId === 'gz-1045')).toBeUndefined();
  });
  test('recorded Typhoon IN-FA-26 reaches the Los Angeles to Shanghai lane but no port', () => {
    const found = exposure(byId(gdacs, 'gdacs:TC:1001343'), places, lanes);
    expect(found.ports).toEqual([]);
    expect(found.lanes).toMatchObject([{ laneId: 'gz-1045', segment: 4 }]);
    expect(found.lanes[0]?.distanceKm).toBeGreaterThan(400);
    expect(found.lanes[0]?.distanceKm).toBeLessThan(radiusKm.cyclone);
  });
});

describe('activity window', () => {
  const champi = byId(gdacs, champiId(gdacs));
  test('recorded Typhoon Champi came within reach of Shanghai while it lasted, and not after', () => {
    expect(exposure(champi, places, []).ports.map(hit => hit.portId)).toEqual(['shanghai']);
    expect(isActive(champi, new Date('2026-10-24T12:00:00Z'))).toBe(true);
    expect(isActive(champi, new Date('2026-10-31T20:00:00Z'))).toBe(false);
  });
  test('an open-ended notice ages out after its kind\'s relevance window', () => {
    const quake = synthetic('earthquake', pointAt(0, 0), { observedAt: '2026-10-28T20:00:00.000Z' });
    expect(isActive(quake, new Date('2026-10-31T19:00:00Z'))).toBe(true);
    expect(isActive(quake, new Date('2026-10-31T21:00:00Z'))).toBe(false);
  });
});

describe('port selection', () => {
  const notices = [...gdacs, ...normalizeNws(nwsRaw, fetchedAt)];
  test('the Los Angeles marine statement reaches Los Angeles while it is in force and only then', () => {
    expect(noticesForPort(notices, 'los-angeles', new Date('2026-10-31T20:00:00Z')).map(entry => entry.notice.provider)).toEqual(['nws']);
    expect(noticesForPort(notices, 'los-angeles', new Date('2026-11-01T02:00:00Z'))).toEqual([]);
    expect(noticesForPort(notices, 'rotterdam', new Date('2026-10-31T20:00:00Z'))).toEqual([]);
  });
});

describe('fetchers report failure as data', () => {
  const now = new Date(fetchedAt);
  test('a recorded success carries fetchedAt and live provenance', async () => {
    const result = await fetchGdacs(now, answering(gdacsRaw));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.notices.every(notice => notice.fetchedAt === fetchedAt && notice.provenance === 'live')).toBe(true);
  });
  test('HTTP errors, network errors, hangs and wrong payloads are all unavailable', async () => {
    const refused = (async () => { throw new Error('connect ECONNREFUSED'); }) as unknown as typeof fetch;
    const hanging = ((_: unknown, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('timed out'))))) as unknown as typeof fetch;
    expect(await fetchGdacs(now, answering({}, 503))).toMatchObject({ status: 'unavailable', message: 'gdacs answered HTTP 503.' });
    expect(await fetchUsgs(now, refused)).toMatchObject({ status: 'unavailable', provider: 'usgs' });
    expect(await fetchNws(now, hanging, 20)).toMatchObject({ status: 'unavailable', provider: 'nws' });
    expect(await fetchNws(now, answering({ title: 'Bad Request' }))).toMatchObject({ status: 'unavailable', message: 'nws answered with an unrecognised payload.' });
  });
  test('the request asks politely: declared user agent and a bounded window', async () => {
    const seen: { url: string; agent: string | null }[] = [];
    const spy = (async (url: string, init?: RequestInit) => { seen.push({ url, agent: new Headers(init?.headers).get('user-agent') }); return new Response(JSON.stringify(usgsRaw)); }) as unknown as typeof fetch;
    await fetchUsgs(now, spy);
    expect(seen[0]?.agent).toContain('gazetteer-demo');
    expect(gdacsUrl(now)).toContain('fromdate=2026-10-17&todate=2026-10-31');
  });
  test('one failing feed never hides the others', async () => {
    const feeds: readonly Feed[] = [{ provider: 'gdacs', fetch: fetchGdacs }, { provider: 'usgs', fetch: fetchUsgs }];
    const result = await sweep(now, (async (url: string) => String(url).includes('gdacs') ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(usgsRaw))) as unknown as typeof fetch, feeds);
    expect(result.failures.map(failure => failure.provider)).toEqual(['gdacs']);
    expect(result.notices.length).toBeGreaterThan(0);
  });
});

describe('live notices as disruptions', () => {
  const entry = noticesForPort(normalizeNws(nwsRaw, fetchedAt), 'los-angeles', new Date('2026-10-31T20:00:00Z'))[0]!;
  test('carry live evidence with provider and url, and no invented delay', () => {
    const disruption = toDisruption(entry);
    expect(disruption).toMatchObject({ portId: 'los-angeles', delayHours: null, evidence: { source: 'live', provider: 'nws', id: entry.notice.id, url: entry.notice.url } });
    expect(disruption.id).toBe(`${entry.notice.id}@los-angeles`);
    expect(disruption.evidence.detail).toContain('declared forecast zone');
    expect(disruption.geometry).toBeUndefined();
  });
  test('a point notice hands the assessor a circle of its declared reach', () => {
    expect(circleOf(synthetic('cyclone', pointAt(10, 20)))).toEqual({ center: [10, 20], radiusKm: radiusKm.cyclone });
    const box = circleOf(synthetic('volcano', { kind: 'bbox', west: 0, south: 0, east: 2, north: 2 }));
    expect(box?.center).toEqual([1, 1]);
    expect(box?.radiusKm).toBeGreaterThan(radiusKm.volcano + 100);
  });
  test('polling is switchable off, and then asks nobody', async () => {
    expect(await pollPort('los-angeles', new Date(fetchedAt), false)).toEqual([]);
  });
});
