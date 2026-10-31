import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../../src/core/demo';
import { ports } from '../../../src/core/ports';
import type { Comment, Dashboard } from '../../../src/core/types';
import { createEventsHandler, frame, pingFrame, preamble } from '../../../src/server/http/events';
import { createHub } from '../../../src/server/runtime/hub';
const dashboard = (delay = 0): Dashboard => ({
  shipments: demoShipments(new Date('2026-10-31T12:00:00.000Z')).map(shipment => ({ ...shipment, delayHours: delay })), ports,
  updatedAt: '2026-10-31T12:00:00.000Z', mode: 'simulation', runtime: 'TEST', relay: 'TEST',
});
const comment: Comment = { id: 'c1', author: 'Ana', body: 'Held at anchorage\nsee "evidence"', createdAt: '2026-10-31T12:01:00.000Z' };

/** Minimal client-side SSE reader over a real Response body. */
const reader = (response: Response) => {
  const stream = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async (timeoutMs = 1000): Promise<string | null> => {
    const timeout = new Promise<null>(done => setTimeout(() => done(null), timeoutMs));
    while (!buffer.includes('\n\n')) {
      const chunk = await Promise.race([stream.read(), timeout]);
      if (chunk === null || chunk.done) return null;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    const end = buffer.indexOf('\n\n');
    const block = buffer.slice(0, end + 2);
    buffer = buffer.slice(end + 2);
    return block;
  };
  return { next, cancel: () => stream.cancel() };
};
const parse = (block: string) => ({
  event: /^event: (.+)$/m.exec(block)?.[1],
  data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? 'null') as unknown,
});
const request = (signal?: AbortSignal) => new Request('https://gazetteer.example/api/workspaces/w1/events', { headers: { Accept: 'text/event-stream' }, ...(signal ? { signal } : {}) });

describe('SSE framing (the contract map-ui consumes)', () => {
  test('retry and ping lines are exactly the agreed bytes', () => {
    expect(preamble).toBe('retry: 3000\n\n');
    expect(pingFrame).toBe(': ping\n\n');
  });
  test('a dashboard frame carries the full Dashboard as one data line', () => {
    const text = frame({ event: 'dashboard', data: dashboard() });
    expect(text.startsWith('event: dashboard\ndata: {')).toBe(true);
    expect(text.endsWith('}\n\n')).toBe(true);
    expect(text.split('\n').filter(line => line.startsWith('data:'))).toHaveLength(1);
    expect(parse(text).data).toEqual(dashboard());
  });
  test('a comment frame is {shipmentId, comment} and survives newlines and quotes in the body', () => {
    const text = frame({ event: 'comment', data: { shipmentId: 's-1', comment } });
    expect(text.split('\n').filter(line => line.startsWith('data:'))).toHaveLength(1);
    expect(parse(text)).toEqual({ event: 'comment', data: { shipmentId: 's-1', comment } });
  });
});

describe('events handler over real Response streams', () => {
  test('answers text/event-stream, opens with the retry line, then streams the workspace events in order', async () => {
    const hub = createHub();
    const response = createEventsHandler({ subscribe: hub.subscribe })(request(), 'w1');
    expect(response.headers.get('Content-Type')).toStartWith('text/event-stream');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
    const client = reader(response);
    expect(await client.next()).toBe(preamble);
    hub.publish('w1', { event: 'dashboard', data: dashboard(36) });
    hub.publish('w1', { event: 'comment', data: { shipmentId: 's-1', comment } });
    expect(parse((await client.next())!)).toEqual({ event: 'dashboard', data: dashboard(36) });
    expect(parse((await client.next())!)).toEqual({ event: 'comment', data: { shipmentId: 's-1', comment } });
    await client.cancel();
  });

  test('another workspace never reaches this stream', async () => {
    const hub = createHub();
    const client = reader(createEventsHandler({ subscribe: hub.subscribe })(request(), 'w1'));
    await client.next();
    hub.publish('w2', { event: 'dashboard', data: dashboard(99) });
    expect(await client.next(150)).toBeNull();
    await client.cancel();
  });

  test('heartbeats arrive as comment lines on the interval', async () => {
    const hub = createHub();
    const client = reader(createEventsHandler({ subscribe: hub.subscribe, pingMs: 25 })(request(), 'w1'));
    await client.next();
    expect(await client.next()).toBe(pingFrame);
    expect(await client.next()).toBe(pingFrame);
    await client.cancel();
  });

  test('a reconnecting client gets the current dashboard once, and a live one that raced ahead wins', async () => {
    const hub = createHub();
    const handler = createEventsHandler({ subscribe: hub.subscribe, snapshot: async () => dashboard(0) });
    const client = reader(handler(request(), 'w1'));
    await client.next();
    expect(parse((await client.next())!)).toEqual({ event: 'dashboard', data: dashboard(0) });
    await client.cancel();

    const slow = createEventsHandler({ subscribe: hub.subscribe, snapshot: async () => { await new Promise(done => setTimeout(done, 40)); return dashboard(0); } });
    const racing = reader(slow(request(), 'w1'));
    await racing.next();
    hub.publish('w1', { event: 'dashboard', data: dashboard(72) });
    expect(parse((await racing.next())!)).toEqual({ event: 'dashboard', data: dashboard(72) });
    expect(await racing.next(150)).toBeNull();
    await racing.cancel();
  });

  test('a failing snapshot leaves the stream open', async () => {
    const hub = createHub();
    const client = reader(createEventsHandler({ subscribe: hub.subscribe, snapshot: async () => { throw new Error('actors down'); } })(request(), 'w1'));
    await client.next();
    hub.publish('w1', { event: 'dashboard', data: dashboard(1) });
    expect(parse((await client.next())!).event).toBe('dashboard');
    await client.cancel();
  });

  test('client abort and stream cancel both release the subscription and the timer', async () => {
    const hub = createHub();
    const abort = new AbortController();
    const aborted = reader(createEventsHandler({ subscribe: hub.subscribe, pingMs: 10 })(request(abort.signal), 'w1'));
    const cancelled = reader(createEventsHandler({ subscribe: hub.subscribe, pingMs: 10 })(request(), 'w1'));
    await aborted.next();
    await cancelled.next();
    expect(hub.subscribers('w1')).toBe(2);
    abort.abort();
    await cancelled.cancel();
    await new Promise(done => setTimeout(done, 20));
    expect(hub.subscribers('w1')).toBe(0);
  });

  test('served by a real Bun server the browser-visible bytes are SSE', async () => {
    const hub = createHub();
    const handler = createEventsHandler({ subscribe: hub.subscribe, pingMs: 30 });
    const server = Bun.serve({ port: 0, fetch: incoming => handler(incoming, 'w1') });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`);
      expect(response.headers.get('Content-Type')).toStartWith('text/event-stream');
      const client = reader(response);
      expect(await client.next()).toBe(preamble);
      hub.publish('w1', { event: 'dashboard', data: dashboard(5) });
      expect(parse((await client.next())!).data).toEqual(dashboard(5));
      await client.cancel();
    } finally {
      await server.stop(true);
    }
  });
});
