import { z } from 'zod';
import type { PortId } from '../../core/ports';
import { getJson, type Fetcher } from './http';
import { userAgent, type FetchResult, type Notice, type NoticeGeometry, type NoticeSeverity } from './notice';

/** NWS forecast zones that contain a demo port. Verified against api.weather.gov/zones/forecast: PZZ655 is "Inner waters from Point Mugu to San Mateo Pt.", which holds San Pedro Bay; CAZ366 is the Los Angeles coast zone of /points/33.74,-118.26. */
const zonePorts: Readonly<Record<string, readonly PortId[]>> = { PZZ655: ['los-angeles'], CAZ366: ['los-angeles'] };

const severities: Readonly<Record<string, NoticeSeverity>> = { Minor: 'minor', Moderate: 'moderate', Severe: 'severe', Extreme: 'extreme', Unknown: 'minor' };
const ring = z.array(z.tuple([z.number(), z.number()]).rest(z.number()));
const geometry = z.union([
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring)) }),
]).nullable();
const feature = z.object({
  geometry,
  properties: z.object({
    id: z.string(), event: z.string(), severity: z.string(), status: z.string(), headline: z.string().nullable().optional(),
    description: z.string().nullable().optional(), effective: z.string(), expires: z.string(), ends: z.string().nullable().optional(),
    geocode: z.object({ UGC: z.array(z.string()) }), '@id': z.string().optional(),
  }),
});
const nwsEnvelope = z.object({ features: z.array(z.unknown()) });

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();
const clip = (text: string, limit: number): string => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
const iso = (value: string): string => new Date(value).toISOString();

type Source = Extract<z.infer<typeof geometry>, object>;
const positions = (source: Source): readonly (readonly number[])[] =>
  source.type === 'Polygon' ? source.coordinates.flat() : source.coordinates.flat(2);

const boundingBox = (source: Source): NoticeGeometry => {
  const lons = positions(source).map(position => position[0] ?? 0);
  const lats = positions(source).map(position => position[1] ?? 0);
  return { kind: 'bbox', west: Math.min(...lons), south: Math.min(...lats), east: Math.max(...lons), north: Math.max(...lats) };
};

const locate = (source: z.infer<typeof geometry>, zones: readonly string[]): NoticeGeometry | null => {
  if (source !== null) return boundingBox(source);
  const portIds = [...new Set(zones.flatMap(zone => zonePorts[zone] ?? []))];
  return portIds.length === 0 ? null : { kind: 'zone', zoneIds: zones.filter(zone => zone in zonePorts), portIds };
};

export const normalizeNws = (raw: unknown, fetchedAt: string): readonly Notice[] => {
  const envelope = nwsEnvelope.safeParse(raw);
  return envelope.success ? envelope.data.features.flatMap((candidate): readonly Notice[] => {
    const parsed = feature.safeParse(candidate);
    if (!parsed.success || parsed.data.properties.status !== 'Actual') return [];
    const p = parsed.data.properties;
    const located = locate(parsed.data.geometry, p.geocode.UGC);
    if (located === null) return [];
    return [{
      id: `nws:${p.id}`, provider: 'nws', kind: 'weather', severity: severities[p.severity] ?? 'minor',
      title: p.headline ? squash(p.headline) : p.event, detail: clip(squash(p.description ?? p.event), 280),
      observedAt: iso(p.effective), expiresAt: iso(p.ends ?? p.expires), geometry: located,
      url: p['@id'] ?? `https://api.weather.gov/alerts/${encodeURIComponent(p.id)}`, fetchedAt, provenance: 'live',
    }];
  }) : [];
};

const nwsUrl = `https://api.weather.gov/alerts/active?zone=${Object.keys(zonePorts).join(',')}`;

export const fetchNws = async (now: Date, fetcher: Fetcher = fetch, timeoutMs = 15_000): Promise<FetchResult> => {
  const response = await getJson('nws', nwsUrl, userAgent, fetcher, timeoutMs);
  if (response.status === 'unavailable') return { status: 'unavailable', provider: 'nws', message: response.message };
  return nwsEnvelope.safeParse(response.value).success
    ? { status: 'ok', provider: 'nws', notices: normalizeNws(response.value, now.toISOString()) }
    : { status: 'unavailable', provider: 'nws', message: 'nws answered with an unrecognised payload.' };
};
