import { createAisStreamHub } from './aisstream';
import { digitrafficSource } from './digitraffic';
import { firstAvailable, type TelemetrySource } from './telemetry';

/** AISStream when a key is set (shared connection), then keyless Digitraffic (Baltic coverage). Module-level: the hub is one process-wide subscription. */
export const telemetrySourceFromEnv = (env: Readonly<Record<string, string | undefined>>): TelemetrySource =>
  env.AISSTREAM_API_KEY ? firstAvailable(createAisStreamHub({ apiKey: env.AISSTREAM_API_KEY }).source, digitrafficSource()) : digitrafficSource();
