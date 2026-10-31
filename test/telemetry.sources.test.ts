import { describe, expect, test } from 'bun:test';
import docSample from './fixtures/telemetry/aisstream-position-report.json';
import digitraffic from './fixtures/telemetry/digitraffic-locations.json';
import { createAisStreamHub, digitrafficSource, firstAvailable, parseLocations, parsePositionReport, type AisSocket } from '../src/server/telemetry';

const fetchedAt = '2026-10-31T19:45:00.000Z';

describe('Digitraffic (real captured AIS)', () => {
  test('a captured feature becomes provenance-stamped telemetry', () => {
    const anchored = parseLocations(digitraffic, '538010578', fetchedAt);
    expect(anchored).toEqual({ status: 'ok', value: expect.objectContaining({ mmsi: '538010578', position: [26.120198, 59.912293], navStatus: 1, provider: 'digitraffic', provenance: 'live', fetchedAt, observedAt: '2026-10-31T19:42:13.537Z' }) });
  });
  test('an MMSI absent from the document, and a malformed document, are unavailable outcomes', () => {
    expect(parseLocations(digitraffic, '111111111', fetchedAt).status).toBe('unavailable');
    expect(parseLocations({ features: [{ mmsi: 'x' }] }, '538010578', fetchedAt).status).toBe('unavailable');
    expect(parseLocations('<html>', '538010578', fetchedAt).status).toBe('unavailable');
  });
  test('HTTP errors, network errors and bad MMSIs are data, never throws', async () => {
    const respond = (body: Response | Error): typeof fetch => (async () => { if (body instanceof Error) throw body; return body; }) as unknown as typeof fetch;
    expect(await digitrafficSource(respond(new Response('no', { status: 503 })))('538010578')).toEqual({ status: 'unavailable', message: 'digitraffic answered HTTP 503' });
    expect((await digitrafficSource(respond(new Error('ECONNRESET')))('538010578')).status).toBe('unavailable');
    expect((await digitrafficSource(respond(Response.json(digitraffic)))('12')).status).toBe('unavailable');
    expect((await digitrafficSource(respond(Response.json(digitraffic)))('538010578')).status).toBe('ok');
  });
  test('firstAvailable falls through unavailable and throwing sources and reports why', async () => {
    const found = parseLocations(digitraffic, '538010578', fetchedAt);
    expect((await firstAvailable(async () => ({ status: 'unavailable', message: 'a' }), async () => { throw new Error('b'); }, async () => found)('538010578')).status).toBe('ok');
    expect(await firstAvailable(async () => ({ status: 'unavailable', message: 'a' }), async () => ({ status: 'unavailable', message: 'b' }))('1')).toEqual({ status: 'unavailable', message: 'a; b' });
  });
});

describe('AISStream message shapes', () => {
  test('the documented PositionReport sample parses; receipt time stands in for the absent time_utc', () => {
    expect(parsePositionReport(docSample, fetchedAt)).toEqual({
      mmsi: '368207620', position: [-80.1918, 25.7617], sogKnots: 12.4, cogDegrees: 86.7, navStatus: null, observedAt: fetchedAt, provenance: 'live', provider: 'aisstream', fetchedAt,
    });
  });
  test('time_utc and AIS "not available" sentinels are honoured', () => {
    const variant = { ...docSample, MetaData: { ...docSample.MetaData, time_utc: '2026-10-31 18:22:32.318353 +0000 UTC' }, Message: { PositionReport: { ...docSample.Message.PositionReport, Sog: 102.3, Cog: 360, NavigationalStatus: 1 } } };
    expect(parsePositionReport(variant, fetchedAt)).toMatchObject({ observedAt: '2026-10-31T18:22:32.318Z', sogKnots: null, cogDegrees: null, navStatus: 1 });
  });
  test('other message types and invalid reports are ignored', () => {
    expect(parsePositionReport({ ...docSample, MessageType: 'ShipStaticData' }, fetchedAt)).toBeNull();
    expect(parsePositionReport({ ...docSample, Message: { PositionReport: { ...docSample.Message.PositionReport, Valid: false } } }, fetchedAt)).toBeNull();
    expect(parsePositionReport({ ...docSample, MetaData: { MMSI: 1, Latitude: 95, Longitude: 0 } }, fetchedAt)).toBeNull();
  });
});

type FakeSocket = AisSocket & { readyState: number; sent: string[]; emit: (message: unknown) => Promise<void> };
const fakeSocket = (): FakeSocket => {
  const socket = {
    readyState: 0, sent: [] as string[], onopen: null, onmessage: null, onclose: null, onerror: null,
    send(data: string) { socket.sent.push(data); }, close() { socket.readyState = 3; },
    emit: async (message: unknown) => { socket.onmessage?.({ data: JSON.stringify(message) }); await new Promise(resolve => setTimeout(resolve, 0)); },
  } as unknown as FakeSocket;
  return socket;
};

describe('AISStream hub', () => {
  test('one shared subscription filters on the tracked MMSIs and serves the latest report', async () => {
    const socket = fakeSocket();
    const hub = createAisStreamHub({ apiKey: 'test-key', socket: () => socket, now: () => fetchedAt });
    expect((await hub.source('368207620')).status).toBe('unavailable');
    socket.readyState = 1;
    socket.onopen?.();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ APIKey: 'test-key', BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: ['368207620'], FilterMessageTypes: ['PositionReport'] });
    await socket.emit({ ...docSample, MetaData: { ...docSample.MetaData, MMSI: 999999999 } });
    expect((await hub.source('368207620')).status).toBe('unavailable');
    await socket.emit(docSample);
    expect(await hub.source('368207620')).toEqual({ status: 'ok', value: expect.objectContaining({ mmsi: '368207620', provider: 'aisstream' }) });
    expect(hub.tracked()).toEqual(['368207620']);
    hub.close();
  });
  test('a server error message is reported through the unavailable outcome', async () => {
    const socket = fakeSocket();
    const hub = createAisStreamHub({ apiKey: 'bad', socket: () => socket });
    await hub.source('368207620');
    await socket.emit({ error: 'Api Key Is Not Valid' });
    expect(await hub.source('368207620')).toEqual({ status: 'unavailable', message: expect.stringContaining('Api Key Is Not Valid') });
    hub.close();
  });
});
