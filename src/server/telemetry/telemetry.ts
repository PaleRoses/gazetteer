export type LonLat = readonly [number, number];
export type TelemetryProvider = 'aisstream' | 'digitraffic';

/** One AIS position report, normalised. `null` means the transponder reported "not available". */
export type Telemetry = Readonly<{
  mmsi: string; position: LonLat; sogKnots: number | null; cogDegrees: number | null; navStatus: number | null;
  observedAt: string; provenance: 'live'; provider: TelemetryProvider; fetchedAt: string;
}>;
export type TelemetryOutcome =
  | Readonly<{ status: 'ok'; value: Telemetry }>
  | Readonly<{ status: 'unavailable'; message: string }>;
export type TelemetrySource = (mmsi: string) => Promise<TelemetryOutcome>;

export const mmsiPattern = /^\d{9}$/;
export const unavailable = (message: string): TelemetryOutcome => ({ status: 'unavailable', message });
export const describeError = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** AIS encodes "not available" as SOG 102.3 and COG 360. */
export const knownSog = (value: number): number | null => value >= 102.3 ? null : value;
export const knownCog = (value: number): number | null => value >= 360 ? null : value;

export const navStatusLabels: Readonly<Record<number, string>> = {
  0: 'under way using engine', 1: 'at anchor', 2: 'not under command', 3: 'restricted manoeuvrability', 4: 'constrained by draught', 5: 'moored',
  6: 'aground', 7: 'engaged in fishing', 8: 'under way sailing', 14: 'AIS-SART active', 15: 'not defined',
};

/** The first source to answer with a position wins; unavailability messages are kept for the report. */
export const firstAvailable = (...sources: readonly TelemetrySource[]): TelemetrySource => async mmsi =>
  sources.reduce<Promise<TelemetryOutcome>>(async (previous, source) => {
    const settled = await previous;
    if (settled.status === 'ok') return settled;
    const next = await source(mmsi).catch((error: unknown) => unavailable(describeError(error)));
    return next.status === 'ok' ? next : unavailable([settled.message, next.message].filter(Boolean).join('; '));
  }, Promise.resolve(unavailable('')));
