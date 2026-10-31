import { describe, expect, test } from 'bun:test';
import { queryTokenSocket } from '../../../src/server/relay/live';

describe('queryTokenSocket', () => {
  test('moves the token into the query string and sends no Authorization header', async () => {
    const seen: Array<{ token: string | null; authorization: string | null; path: string }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: (request, bunServer) => {
        const url = new URL(request.url);
        seen.push({ token: url.searchParams.get('token'), authorization: request.headers.get('authorization'), path: url.pathname });
        return bunServer.upgrade(request) ? undefined : new Response('no', { status: 400 });
      },
      websocket: { message: (socket, data) => { socket.send(data); } },
    });
    try {
      const Socket = queryTokenSocket('ot_live_test');
      const socket = new Socket(`ws://127.0.0.1:${server.port}/v1/ws`, { headers: { authorization: 'Bearer ot_live_test' } } as never);
      const echoed = await new Promise<string>((done, fail) => {
        socket.onopen = () => socket.send('ping');
        socket.onmessage = event => done(String(event.data));
        socket.onerror = () => fail(new Error('socket failed'));
      });
      socket.close();
      expect(echoed).toBe('ping');
      expect(seen).toEqual([{ token: 'ot_live_test', authorization: null, path: '/v1/ws' }]);
    } finally {
      await server.stop(true);
    }
  });
});
