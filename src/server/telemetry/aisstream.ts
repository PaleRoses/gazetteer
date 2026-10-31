import { z } from 'zod';
import { describeError, knownCog, knownSog, mmsiPattern, unavailable, type Telemetry, type TelemetrySource } from './telemetry';

/**
 * AISStream (https://aisstream.io/documentation), wss://stream.aisstream.io/v0/stream. The message shapes below follow that documentation;
 * its example repository (github.com/aisstream/example) carries no licence, so none of its code is copied.
 * Limits that shape this module: 3 connections per account, 1 subscription update per second, 200 MMSI filters. One shared connection serves every ship.
 */
export const aisstreamUrl = 'wss://stream.aisstream.io/v0/stream';
const resubscribeDelayMs = 1_100;
const maxFilters = 200;

const positionReportSchema = z.object({
  MessageType: z.literal('PositionReport'),
  MetaData: z.object({ MMSI: z.number().int(), Latitude: z.number().optional(), Longitude: z.number().optional(), time_utc: z.string().optional() }),
  Message: z.object({ PositionReport: z.object({
    Sog: z.number().optional(), Cog: z.number().optional(), NavigationalStatus: z.number().int().optional(),
    Latitude: z.number().optional(), Longitude: z.number().optional(), Valid: z.boolean().optional(),
  }) }),
});

/** "2022-12-29 18:22:32.318353 +0000 UTC" as AISStream writes MetaData.time_utc. */
const parseTimeUtc = (value: string | undefined): string | null => {
  const match = value && /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))? \+0000 UTC$/.exec(value);
  const parsed = match ? Date.parse(`${match[1]}T${match[2]}.${(match[3] ?? '0').slice(0, 3).padEnd(3, '0')}Z`) : NaN;
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};

/** Pure: a PositionReport message as telemetry; anything else, or a report without a position, is null. `receivedAt` stands in when the message carries no time. */
export function parsePositionReport(raw: unknown, receivedAt: string): Telemetry | null {
  const parsed = positionReportSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { MetaData: meta, Message: { PositionReport: report } } = parsed.data;
  const lon = report.Longitude ?? meta.Longitude;
  const lat = report.Latitude ?? meta.Latitude;
  if (lon === undefined || lat === undefined || report.Valid === false || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    mmsi: String(meta.MMSI), position: [lon, lat], sogKnots: report.Sog === undefined ? null : knownSog(report.Sog), cogDegrees: report.Cog === undefined ? null : knownCog(report.Cog),
    navStatus: report.NavigationalStatus ?? null, observedAt: parseTimeUtc(meta.time_utc) ?? receivedAt, provenance: 'live', provider: 'aisstream', fetchedAt: receivedAt,
  };
}

export type AisSocket = {
  onopen: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null;
  send(data: string): void; close(): void; readonly readyState: number;
};
export type SocketFactory = (url: string) => AisSocket;
const open = 1;

const decode = async (data: unknown): Promise<string> =>
  typeof data === 'string' ? data
    : data instanceof Blob ? data.text()
      : data instanceof ArrayBuffer || ArrayBuffer.isView(data) ? new TextDecoder().decode(data as ArrayBuffer) : '';

export type AisStreamHub = Readonly<{ source: TelemetrySource; tracked: () => readonly string[]; close: () => void }>;

/** The one stateful edge: a shared subscription that keeps the latest report per tracked MMSI. Failures surface as unavailable outcomes. */
export function createAisStreamHub(options: Readonly<{
  apiKey: string; socket?: SocketFactory; now?: () => string; reconnectMs?: number;
}>): AisStreamHub {
  const { apiKey, socket: make = url => new WebSocket(url) as unknown as AisSocket, now = () => new Date().toISOString(), reconnectMs = 5_000 } = options;
  const wanted = new Set<string>();
  const latest = new Map<string, Telemetry>();
  let connection: AisSocket | null = null;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastError: string | null = null;
  let closed = false;

  const subscribe = (): void => {
    if (!connection || connection.readyState !== open || wanted.size === 0) return;
    connection.send(JSON.stringify({ APIKey: apiKey, BoundingBoxes: [[[-90, -180], [90, 180]]], FiltersShipMMSI: [...wanted].slice(0, maxFilters), FilterMessageTypes: ['PositionReport'] }));
  };
  const later = (slot: 'subscribe' | 'reconnect', delayMs: number, action: () => void): void => {
    clearTimeout(timers.get(slot));
    timers.set(slot, setTimeout(() => { timers.delete(slot); action(); }, delayMs));
  };
  const connect = (): void => {
    if (closed || connection) return;
    try {
      const socket = make(aisstreamUrl);
      connection = socket;
      socket.onopen = subscribe;
      socket.onmessage = event => {
        void decode(event.data).then(text => {
          const message = JSON.parse(text) as unknown;
          const error = z.object({ error: z.string() }).safeParse(message);
          if (error.success) { lastError = error.data.error; return; }
          const report = parsePositionReport(message, now());
          if (report) latest.set(report.mmsi, report);
        }).catch(() => undefined);
      };
      socket.onerror = () => { lastError = lastError ?? 'AISStream socket error'; };
      socket.onclose = () => { connection = null; if (!closed) later('reconnect', reconnectMs, connect); };
    } catch (error) {
      connection = null;
      lastError = describeError(error);
      later('reconnect', reconnectMs, connect);
    }
  };

  const source: TelemetrySource = async mmsi => {
    if (!mmsiPattern.test(mmsi)) return unavailable(`invalid MMSI ${mmsi}`);
    if (!wanted.has(mmsi)) { wanted.add(mmsi); later('subscribe', resubscribeDelayMs, subscribe); }
    connect();
    const report = latest.get(mmsi);
    return report ? { status: 'ok', value: report } : unavailable(`aisstream: no position report yet for MMSI ${mmsi}${lastError ? ` (${lastError})` : ''}`);
  };
  return { source, tracked: () => [...wanted], close: () => { closed = true; timers.forEach(clearTimeout); timers.clear(); connection?.close(); connection = null; } };
}
