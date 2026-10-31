import { describe, expect, test } from 'bun:test';
import { Effect, Exit, Stream } from 'effect';
import { decode, digitrafficFeed, type Connect, type MqttClient } from '../../../src/server/ingest/digitraffic';
import { FeedError } from '../../../src/server/ingest/pipeline';

const location = '{"cog":101.3,"heading":100,"lat":60.1445,"lon":28.065617,"navStat":0,"posAcc":false,"raim":false,"rot":0,"sog":18.1,"time":1793479709}';
const metadata = '{"callSign":"OJTD","destination":"FINLI","draught":59,"eta":723392,"imo":9163647,"name":"AURELIE","posType":1,"refA":80,"refB":10,"refC":7,"refD":7,"timestamp":1793479712043,"type":70}';

describe('Digitraffic decoding', () => {
  test('a location takes its MMSI from the topic and turns the sentinels into null', () => {
    expect(decode('vessels-v2/311000972/location', location)).toEqual({ kind: 'position', frame: { mmsi: 311000972, at: 1793479709, lat: 60.1445, lon: 28.065617, sogKnots: 18.1, cogDeg: 101.3, navStatus: 0 } });
    const unknown = decode('vessels-v2/311000972/location', location.replace('"sog":18.1', '"sog":102.3').replace('"cog":101.3', '"cog":360').replace('"navStat":0', '"navStat":15'));
    expect(unknown).toMatchObject({ frame: { sogKnots: null, cogDeg: null, navStatus: null } });
  });

  test('metadata yields the ship type', () => {
    expect(decode('vessels-v2/230039000/metadata', metadata)).toEqual({ kind: 'static', mmsi: 230039000, shipType: 70 });
  });

  test('anything else is an invalid event, never a throw', () => {
    ['not json', '{"lat":"x"}', ''].forEach(payload => expect(decode('vessels-v2/230039000/location', payload)).toEqual({ kind: 'invalid' }));
    expect(decode('vessels-v2/abc/location', location)).toEqual({ kind: 'invalid' });
    expect(decode('vessels-v2/230039000/status', location)).toEqual({ kind: 'invalid' });
  });
});

type Handlers = Record<string, (...args: any[]) => void>;
const fake = (): Readonly<{ connect: Connect; handlers: Handlers; log: string[] }> => {
  const handlers: Handlers = {};
  const log: string[] = [];
  const client: MqttClient = {
    on: (event, listener) => { handlers[event] = listener; },
    subscribe: topics => { log.push(`subscribe ${topics.join(',')}`); },
    endAsync: async () => { log.push('end'); },
  };
  return { connect: (_url, options) => { log.push(`connect reconnectPeriod=${options.reconnectPeriod}`); return client; }, handlers, log };
};

describe('the Digitraffic feed', () => {
  test('messages become events, and releasing the scope ends the client', async () => {
    const { connect, handlers, log } = fake();
    const collected = Effect.runPromise(Stream.runCollect(Stream.take(digitrafficFeed(connect), 2)));
    await Bun.sleep(10);
    handlers.connect!();
    handlers.message!('vessels-v2/230039000/metadata', new TextEncoder().encode(metadata));
    handlers.message!('vessels-v2/311000972/location', new TextEncoder().encode(location));
    const events = await collected;
    expect(events.map(event => event.kind)).toEqual(['static', 'position']);
    expect(log).toEqual(['connect reconnectPeriod=0', 'subscribe vessels-v2/+/location,vessels-v2/+/metadata', 'end']);
  });

  test('a closed connection fails the stream with a typed FeedError', async () => {
    const { connect, handlers } = fake();
    const outcome = Effect.runPromiseExit(Stream.runDrain(digitrafficFeed(connect)));
    await Bun.sleep(10);
    handlers.close!();
    const exit = await outcome;
    expect(Exit.isFailure(exit)).toBe(true);
    expect(JSON.stringify(exit)).toContain('digitraffic: connection closed');
    expect(new FeedError({ reason: 'x' })._tag).toBe('FeedError');
  });

  test('the sliding buffer drops the oldest events under a burst instead of blocking the client', async () => {
    const { connect, handlers } = fake();
    const collected = Effect.runPromise(Stream.runCollect(Stream.take(digitrafficFeed(connect), 1)));
    await Bun.sleep(10);
    handlers.connect!();
    Array.from({ length: 50_000 }, () => handlers.message!('vessels-v2/311000972/location', location));
    expect((await collected).length).toBe(1);
  });
});
