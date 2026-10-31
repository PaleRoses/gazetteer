import { z } from 'zod';
import { getJson, type Fetcher } from './http';
import { userAgent, type FetchResult, type Notice, type NoticeSeverity } from './notice';

const feature = z.object({
  id: z.string(),
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]).rest(z.number()) }),
  properties: z.object({
    mag: z.number().nullable(), place: z.string().nullable(), time: z.number(), url: z.string(),
    tsunami: z.number(), type: z.string(), status: z.string().optional(),
  }),
});
export const usgsEnvelope = z.object({ features: z.array(z.unknown()) });

/** USGS magnitude bands; a tsunami-flagged event is never below moderate. */
export const usgsSeverity = (magnitude: number, tsunami: boolean): NoticeSeverity => {
  const byMagnitude: NoticeSeverity = magnitude >= 7.5 ? 'extreme' : magnitude >= 6.5 ? 'severe' : magnitude >= 5.5 ? 'moderate' : 'minor';
  return tsunami && byMagnitude === 'minor' ? 'moderate' : byMagnitude;
};

export const normalizeUsgs = (raw: unknown, fetchedAt: string): readonly Notice[] => {
  const envelope = usgsEnvelope.safeParse(raw);
  return envelope.success ? envelope.data.features.flatMap((candidate): readonly Notice[] => {
    const parsed = feature.safeParse(candidate);
    if (!parsed.success || parsed.data.properties.type !== 'earthquake' || parsed.data.properties.mag === null) return [];
    const { id, geometry, properties: p } = parsed.data;
    const magnitude = p.mag ?? 0;
    const tsunami = p.tsunami === 1;
    return [{
      id: `usgs:${id}`, provider: 'usgs', kind: 'earthquake', severity: usgsSeverity(magnitude, tsunami),
      title: `M ${magnitude.toFixed(1)} earthquake · ${p.place ?? 'unknown location'}`,
      detail: [`Depth ${geometry.coordinates[2]?.toFixed(0) ?? '?'} km`, p.status ?? 'status unknown', tsunami ? 'USGS tsunami flag set' : null].filter(part => part !== null).join(' · '),
      observedAt: new Date(p.time).toISOString(), expiresAt: null,
      geometry: { kind: 'point', coordinates: [geometry.coordinates[0], geometry.coordinates[1]] },
      url: p.url, fetchedAt, provenance: 'live',
    }];
  }) : [];
};

export const usgsUrl = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson';

export const fetchUsgs = async (now: Date, fetcher: Fetcher = fetch, timeoutMs = 15_000): Promise<FetchResult> => {
  const response = await getJson('usgs', usgsUrl, userAgent, fetcher, timeoutMs);
  if (response.status === 'unavailable') return { status: 'unavailable', provider: 'usgs', message: response.message };
  return usgsEnvelope.safeParse(response.value).success
    ? { status: 'ok', provider: 'usgs', notices: normalizeUsgs(response.value, now.toISOString()) }
    : { status: 'unavailable', provider: 'usgs', message: 'usgs answered with an unrecognised payload.' };
};
