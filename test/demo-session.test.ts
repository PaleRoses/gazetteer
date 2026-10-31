import { describe, expect, test } from 'bun:test';
import { relaySuccess } from '../src/shared';
import { createAccess } from '../src/server/access';
import { createApi } from '../src/server/http';

const monitoring = { dashboard: async () => relaySuccess(undefined as never), simulate: async () => relaySuccess(undefined as never) };
const post = (origin: string, path: string, requestOrigin = origin): Request => new Request(`${origin}${path}`, { method: 'POST', headers: { Origin: requestOrigin } });
const enter = async (api: ReturnType<typeof createApi>, origin: string) => {
  const response = await api(post(origin, '/api/demo-session'));
  return { response, body: response.status === 200 ? await response.clone().json() as { user: { id: string; email: string }; workspaces: readonly { id: string; name: string }[] } : null };
};

describe('demo sign-in', () => {
  test('a loopback origin gets a session for one demo operator and workspace, reused on every later call', async () => {
    const access = createAccess(':memory:');
    const origin = 'http://localhost:4310';
    const api = createApi({ access, monitoring, origin });
    const first = await enter(api, origin);
    const second = await enter(api, origin);
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get('Set-Cookie')).toContain('gazetteer_session=');
    expect(first.body?.user.email).toBe('demo@gazetteer.local');
    expect(first.body?.workspaces.map(workspace => workspace.name)).toEqual(['Demo fleet']);
    expect(second.body?.user.id).toBe(first.body?.user.id);
    expect(second.body?.workspaces[0]?.id).toBe(first.body?.workspaces[0]?.id);
    expect(access.workspaceIds()).toHaveLength(1);
    const cookie = first.response.headers.get('Set-Cookie')?.split(';')[0] ?? '';
    const session = await api(new Request(`${origin}/api/session`, { headers: { Cookie: cookie } }));
    expect(session.status).toBe(200);
    access.close();
  });

  test('the demo account cannot be signed into with a guessed password', async () => {
    const access = createAccess(':memory:');
    const origin = 'http://127.0.0.1:4310';
    const api = createApi({ access, monitoring, origin });
    await enter(api, origin);
    const attempt = await api(new Request(`${origin}/api/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'demo@gazetteer.local', password: 'password12345' }) }));
    expect(attempt.status).toBe(401);
    access.close();
  });

  test('a public origin refuses it and reports it unavailable', async () => {
    const access = createAccess(':memory:');
    const origin = 'https://gazetteer.example';
    const api = createApi({ access, monitoring, origin });
    const refused = await api(post(origin, '/api/demo-session'));
    expect(refused.status).toBe(403);
    expect(refused.headers.get('Set-Cookie')).toBeNull();
    expect(await (await api(new Request(`${origin}/api/demo-session`))).json()).toEqual({ available: false });
    expect(access.workspaceIds()).toHaveLength(0);
    access.close();
  });

  test('GAZETTEER_DEMO=off refuses it even on localhost', async () => {
    const access = createAccess(':memory:');
    const origin = 'http://localhost:4310';
    const previous = process.env.GAZETTEER_DEMO;
    process.env.GAZETTEER_DEMO = 'off';
    const api = createApi({ access, monitoring, origin });
    if (previous === undefined) delete process.env.GAZETTEER_DEMO; else process.env.GAZETTEER_DEMO = previous;
    expect((await api(post(origin, '/api/demo-session'))).status).toBe(403);
    expect(await (await api(new Request(`${origin}/api/demo-session`))).json()).toEqual({ available: false });
    access.close();
  });

  test('a cross-origin POST is refused like every other POST', async () => {
    const access = createAccess(':memory:');
    const origin = 'http://localhost:4310';
    const api = createApi({ access, monitoring, origin });
    expect((await api(post(origin, '/api/demo-session', 'https://evil.example'))).status).toBe(403);
    expect(access.workspaceIds()).toHaveLength(0);
    access.close();
  });
});
