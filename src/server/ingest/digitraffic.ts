import mqtt from 'mqtt';
import { Cause, Effect, Queue, Stream } from 'effect';
import { z } from 'zod';
import { knownCog, knownSog } from '../telemetry/telemetry';
import { feed as constants } from './constants';
import type { FeedEvent } from './frame';
import { FeedError, type Feed } from './pipeline';

/** Fintraffic Digitraffic marine AIS over MQTT (CC BY 4.0): keyless, Baltic coverage. https://www.digitraffic.fi/en/marine-traffic/ */
const digitrafficUrl = 'wss://meri.digitraffic.fi:443/mqtt';
const digitrafficTopics = ['vessels-v2/+/location', 'vessels-v2/+/metadata'] as const;

const location = z.object({ lat: z.number(), lon: z.number(), sog: z.number(), cog: z.number(), navStat: z.number().int(), time: z.number() });
const metadata = z.object({ type: z.number().int() });
const topicPattern = /^vessels-v2\/(\d{9})\/(location|metadata)$/;

/** Pure: one MQTT message as a feed event. The MMSI is only in the topic. Anything unparseable is an `invalid` event, counted by the core. */
export const decode = (topic: string, payload: Uint8Array | string): FeedEvent => {
  const match = topicPattern.exec(topic);
  const body = (() => { try { return JSON.parse(typeof payload === 'string' ? payload : new TextDecoder().decode(payload)) as unknown; } catch { return undefined; } })();
  if (!match || body === undefined) return { kind: 'invalid' };
  const mmsi = Number(match[1]);
  if (match[2] === 'metadata') {
    const parsed = metadata.safeParse(body);
    return parsed.success ? { kind: 'static', mmsi, shipType: parsed.data.type } : { kind: 'invalid' };
  }
  const parsed = location.safeParse(body);
  return parsed.success
    ? { kind: 'position', frame: { mmsi, at: parsed.data.time, lat: parsed.data.lat, lon: parsed.data.lon, sogKnots: knownSog(parsed.data.sog), cogDeg: knownCog(parsed.data.cog), navStatus: parsed.data.navStat === 15 ? null : parsed.data.navStat } }
    : { kind: 'invalid' };
};

export type MqttClient = Readonly<{
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  subscribe: (topics: readonly string[]) => unknown;
  endAsync: (force?: boolean) => Promise<unknown>;
}>;
export type Connect = (url: string, options: Readonly<{ clientId: string; reconnectPeriod: number; connectTimeout: number }>) => MqttClient;

const clientId = (): string => `gazetteer-${Math.random().toString(16).slice(2, 10)}`;

/**
 * One MQTT client for the whole process, acquired in a scope and released with it. Automatic reconnect is off (`reconnectPeriod: 0`): a
 * dropped connection fails the stream and `reconnectPolicy` decides when to try again. A slow consumer drops the oldest events (sliding queue).
 */
export const digitrafficFeed = (connect: Connect = mqtt.connect as unknown as Connect): Feed =>
  Stream.callback<FeedEvent, FeedError>(queue => Effect.acquireRelease(
    Effect.sync(() => {
      const fail = (reason: string): void => { Queue.failCauseUnsafe(queue, Cause.fail(new FeedError({ reason }))); };
      const client = connect(digitrafficUrl, { clientId: clientId(), reconnectPeriod: 0, connectTimeout: constants.connectTimeoutMillis });
      client.on('connect', () => client.subscribe(digitrafficTopics));
      client.on('message', (topic: string, payload: Uint8Array) => { Queue.offerUnsafe(queue, decode(topic, payload)); });
      client.on('error', (error: unknown) => fail(`digitraffic: ${error instanceof Error ? error.message : String(error)}`));
      client.on('close', () => fail('digitraffic: connection closed'));
      return client;
    }),
    client => Effect.promise(() => client.endAsync(true)),
  ), { bufferSize: constants.bufferSize, strategy: 'sliding' });
