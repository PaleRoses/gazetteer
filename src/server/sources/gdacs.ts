import { z } from 'zod';
import { getJson, type Fetcher } from './http';
import { userAgent, type FetchResult, type Notice, type NoticeKind, type NoticeSeverity } from './notice';

const kinds: Readonly<Record<string, NoticeKind>> = { TC: 'cyclone', FL: 'flood', VO: 'volcano', EQ: 'earthquake' };
const severities: Readonly<Record<string, NoticeSeverity>> = { Green: 'minor', Orange: 'moderate', Red: 'severe' };

const feature = z.object({
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number(), z.number()]).rest(z.number()) }),
  properties: z.object({
    eventtype: z.string(), eventid: z.number(), name: z.string(), alertlevel: z.string(), iscurrent: z.string(),
    todate: z.string(), datemodified: z.string(), country: z.string().optional(),
    url: z.object({ report: z.string() }),
    severitydata: z.object({ severitytext: z.string() }).optional(),
  }),
});
export const gdacsEnvelope = z.object({ features: z.array(z.unknown()) });

/** GDACS timestamps are UTC without a zone designator. */
const utc = (value: string): string => `${value}Z`;
const meaningful = (text: string | undefined): string | null => {
  const trimmed = text?.trim() ?? '';
  return trimmed === '' || /^Magnitude 0$/.test(trimmed) ? null : trimmed;
};

export const normalizeGdacs = (raw: unknown, fetchedAt: string): readonly Notice[] => {
  const envelope = gdacsEnvelope.safeParse(raw);
  return envelope.success ? envelope.data.features.flatMap((candidate): readonly Notice[] => {
    const parsed = feature.safeParse(candidate);
    if (!parsed.success) return [];
    const { geometry, properties: p } = parsed.data;
    const kind = kinds[p.eventtype];
    const severity = severities[p.alertlevel];
    if (kind === undefined || severity === undefined) return [];
    const detail = [meaningful(p.severitydata?.severitytext), p.country, `GDACS ${p.alertlevel.toLowerCase()} alert`].filter(part => part !== null && part !== undefined && part !== '').join(' · ');
    return [{
      id: `gdacs:${p.eventtype}:${p.eventid}`, provider: 'gdacs', kind, severity, title: p.name, detail,
      observedAt: utc(p.datemodified), expiresAt: p.iscurrent === 'true' ? null : utc(p.todate),
      geometry: { kind: 'point', coordinates: [geometry.coordinates[0], geometry.coordinates[1]] },
      url: p.url.report, fetchedAt, provenance: 'live',
    }];
  }) : [];
};

const dateOnly = (at: Date): string => at.toISOString().slice(0, 10);

export const gdacsUrl = (now: Date, lookbackDays = 14): string =>
  `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?eventlist=TC,FL,VO&alertlevel=green;orange;red&fromdate=${dateOnly(new Date(now.getTime() - lookbackDays * 86_400_000))}&todate=${dateOnly(now)}`;

export const fetchGdacs = async (now: Date, fetcher: Fetcher = fetch, timeoutMs = 15_000): Promise<FetchResult> => {
  const response = await getJson('gdacs', gdacsUrl(now), userAgent, fetcher, timeoutMs);
  if (response.status === 'unavailable') return { status: 'unavailable', provider: 'gdacs', message: response.message };
  return gdacsEnvelope.safeParse(response.value).success
    ? { status: 'ok', provider: 'gdacs', notices: normalizeGdacs(response.value, now.toISOString()) }
    : { status: 'unavailable', provider: 'gdacs', message: 'gdacs answered with an unrecognised payload.' };
};
