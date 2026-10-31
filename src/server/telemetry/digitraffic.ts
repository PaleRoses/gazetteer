import { z } from 'zod';
import { describeError, knownCog, knownSog, mmsiPattern, unavailable, type Telemetry, type TelemetryOutcome, type TelemetrySource } from './telemetry';

/** Fintraffic Digitraffic marine AIS, open data (CC BY 4.0). https://www.digitraffic.fi/en/marine-traffic/ — keyless REST, Baltic coverage. */
const digitrafficLocationsUrl = 'https://meri.digitraffic.fi/api/ais/v1/locations';
const userAgent = 'gazetteer-hackathon';

const featureSchema = z.object({
  mmsi: z.number().int(),
  geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
  properties: z.object({ sog: z.number(), cog: z.number(), navStat: z.number().int(), timestampExternal: z.number() }),
});
const locationsSchema = z.object({ features: z.array(featureSchema) });
type DigitrafficFeature = z.infer<typeof featureSchema>;

const toTelemetry = (feature: DigitrafficFeature, fetchedAt: string): Telemetry => ({
  mmsi: String(feature.mmsi), position: feature.geometry.coordinates, sogKnots: knownSog(feature.properties.sog), cogDegrees: knownCog(feature.properties.cog),
  navStatus: feature.properties.navStat, observedAt: new Date(feature.properties.timestampExternal).toISOString(), provenance: 'live', provider: 'digitraffic', fetchedAt,
});

/** Pure: the latest report for an MMSI in a locations document. */
export function parseLocations(raw: unknown, mmsi: string, fetchedAt: string): TelemetryOutcome {
  const parsed = locationsSchema.safeParse(raw);
  if (!parsed.success) return unavailable(`digitraffic answered an unexpected document: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const feature = parsed.data.features.find(item => String(item.mmsi) === mmsi);
  return feature ? { status: 'ok', value: toTelemetry(feature, fetchedAt) } : unavailable(`digitraffic has no recent position for MMSI ${mmsi}`);
}

export const digitrafficSource = (fetcher: typeof fetch = fetch, now: () => string = () => new Date().toISOString(), timeoutMs = 10_000): TelemetrySource => async mmsi => {
  if (!mmsiPattern.test(mmsi)) return unavailable(`invalid MMSI ${mmsi}`);
  try {
    const response = await fetcher(`${digitrafficLocationsUrl}?mmsi=${mmsi}`, { headers: { 'Digitraffic-User': userAgent, 'User-Agent': userAgent, Accept: 'application/json', 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(timeoutMs) });
    return response.ok ? parseLocations(await response.json() as unknown, mmsi, now()) : unavailable(`digitraffic answered HTTP ${response.status}`);
  } catch (error) {
    return unavailable(`digitraffic is unreachable: ${describeError(error)}`);
  }
};
