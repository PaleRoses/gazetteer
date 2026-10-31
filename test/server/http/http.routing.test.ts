import { describe, expect, test } from 'bun:test';
import { demoShipments } from '../../../src/core/demo';
import { ports } from '../../../src/core/ports';
import { relaySuccess, type Dashboard } from '../../../src/core/types';
import { createAccess } from '../../../src/server/access/access';
import { createApi } from '../../../src/server/http/api';

const origin = 'https://gazetteer.example';
const dashboard: Dashboard = { shipments: demoShipments(new Date('2026-10-31T12:00:00.000Z')), ports, updatedAt: '2026-10-31T12:00:00.000Z', mode: 'simulation', runtime: 'T', relay: 'T' };
const monitoring = { dashboard: async () => relaySuccess(dashboard), simulate: async () => relaySuccess(dashboard) };

async function setup() {
  const access = createAccess(':memory:');
  const api = createApi({ access, monitoring, origin, demo: false });
  const owner = await access.signup({ email: 'owner@example.com', name: 'Owner', password: 'correct horse battery staple' });
  const outsider = await access.signup({ email: 'out@example.com', name: 'Out', password: 'correct horse battery staple' });
  if (!owner.ok || !outsider.ok) throw new Error('seed');
  const workspace = access.workspaces(owner.value.user.id);
  if (!workspace.ok || !workspace.value[0]) throw new Error('seed');
  const call = (method: string, path: string, who: 'owner' | 'outsider' | null = 'owner', extra: Readonly<{ type?: string; body?: string }> = {}) => api(new Request(`${origin}${path.replace('<ws>', workspace.value[0]!.id)}`, {
    method,
    headers: { Origin: origin, ...(who ? { Cookie: `gazetteer_session=${(who === 'owner' ? owner : outsider).value.token}` } : {}), ...(extra.type ? { 'Content-Type': extra.type } : {}) },
    ...(extra.body !== undefined && method === 'POST' ? { body: extra.body } : {}),
  }));
  return { call };
}
const statusOf = async (pending: Promise<Response>): Promise<number> => (await pending).status;

// The router is stricter than a framework's defaults on purpose: these answers are the contract the client and the older server shared.
describe('routing precedence', () => {
  test('methods other than GET and POST are refused before anything else, HEAD included', async () => {
    const { call } = await setup();
    expect(await Promise.all(['PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].map(method => statusOf(call(method, '/api/session', null))))).toEqual([405, 405, 405, 405, 405]);
  });

  test('a session is demanded before a route is found: an unknown path is 401 signed out and 404 signed in', async () => {
    const { call } = await setup();
    expect(await statusOf(call('GET', '/api/nothing', null))).toBe(401);
    expect(await statusOf(call('GET', '/api/signup', null))).toBe(401);
    expect(await statusOf(call('GET', '/api/nothing'))).toBe(404);
  });

  test('membership guards known workspace resources only: an unknown one is 404 even for an outsider, a wrong method on a known one is 405 after membership', async () => {
    const { call } = await setup();
    expect(await statusOf(call('GET', '/api/workspaces/<ws>/nothing', 'outsider'))).toBe(404);
    expect(await statusOf(call('GET', '/api/workspaces/<ws>/dashboard', 'outsider'))).toBe(403);
    expect(await statusOf(call('POST', '/api/workspaces/<ws>/dashboard', 'outsider', { type: 'application/json', body: '{}' }))).toBe(403);
    expect(await statusOf(call('POST', '/api/workspaces/<ws>/dashboard', 'owner', { type: 'application/json', body: '{}' }))).toBe(405);
    expect(await statusOf(call('GET', '/api/workspaces/<ws>/disruptions'))).toBe(405);
  });

  test('paths are exact: a trailing slash is not the resource', async () => {
    const { call } = await setup();
    expect(await statusOf(call('GET', '/api/workspaces/<ws>/dashboard/'))).toBe(404);
    expect(await statusOf(call('GET', '/api/workspaces/<ws>/dashboard/', 'outsider'))).toBe(404);
  });

  test('ids are matched as written: a percent-encoded shipment id is not the decoded one', async () => {
    const { call } = await setup();
    expect(await statusOf(call('GET', '/api/workspaces/<ws>/shipments/gz-1042/comments'))).toBe(200);
    expect(await statusOf(call('GET', '/api/workspaces/<ws>/shipments/gz%2D1042/comments'))).toBe(404);
  });
});

describe('bodies', () => {
  test('not JSON is 415, malformed or invalid JSON is one 400, and the order of checks is origin, throttle, type, body', async () => {
    const { call } = await setup();
    const signup = (type: string | undefined, body: string) => call('POST', '/api/signup', null, { ...(type ? { type } : {}), body });
    expect(await statusOf(signup('text/plain', '{}'))).toBe(415);
    expect(await statusOf(signup(undefined, '{}'))).toBe(415);
    for (const body of ['', 'not json', '[]', '{}', '{"email":']) expect(await (await signup('application/json', body)).json()).toEqual({ error: 'Invalid request fields' });
    expect(await statusOf(signup('application/json; charset=utf-8', '{"email":'))).toBe(400);
  });
});
