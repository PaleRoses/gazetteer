import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { demoShipments, ports } from '../src/domain';
import type { Dashboard } from '../src/shared';
import { createAccess } from '../src/server/access';
import { createApi } from '../src/server/http';
import type { Monitoring } from '../src/server/monitoring';

const origin = 'https://gazetteer.example';
const dashboard: Dashboard = {
  shipments: demoShipments(new Date('2026-10-31T12:00:00.000Z')), ports,
  updatedAt: '2026-10-31T12:00:00.000Z', mode: 'simulation',
  runtime: 'TEST fixture — no Terse runtime', relay: 'TEST fixture — no Relay connection',
};
// HTTP authorization contract only. Actor/Relay integration is tested by its actual runtime owner.
const monitoringFixture: Pick<Monitoring, 'dashboard' | 'simulate'> = {
  dashboard: async () => dashboard,
  simulate: async () => dashboard,
};
const authBody = z.object({ user: z.object({ id: z.string(), name: z.string(), email: z.string() }), workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['owner', 'member']) })) });
const inviteBody = z.object({ email: z.string(), url: z.string().url(), delivery: z.literal('link-only') });
const request = (path: string, cookie?: string, body?: unknown, requestOrigin = origin): Request => new Request(`${origin}${path}`, {
  method: body === undefined ? 'GET' : 'POST',
  headers: { Origin: requestOrigin, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const signup = async (api: ReturnType<typeof createApi>, name: string) => {
  const response = await api(request('/api/signup', undefined, { name, email: `${name}@example.com`, password: 'correct horse battery staple' }));
  expect(response.status).toBe(200);
  const cookie = response.headers.get('Set-Cookie');
  if (!cookie) throw new Error('Signup did not set session cookie');
  const payload: unknown = await response.json();
  return { cookie, ...authBody.parse(payload) };
};

describe('HTTP access boundary', () => {
  test('throttles signup and login together by trusted peer, not supplied headers', async () => {
    const access = createAccess(':memory:');
    const api = createApi({ access, monitoring: monitoringFixture, origin });
    const responses = await Promise.all(Array.from({ length: 20 }, () => api(request('/api/login', undefined, { email: 'missing@example.com', password: 'wrong' }), 'peer-one')));
    expect(responses.map(response => response.status)).toEqual(Array.from({ length: 20 }, () => 401));
    const throttled = request('/api/signup', undefined, { name: 'blocked', email: 'blocked@example.com', password: 'correct horse battery staple' });
    throttled.headers.set('X-Forwarded-For', 'untrusted-new-peer');
    expect((await api(throttled, 'peer-one')).status).toBe(429);
    expect((await api(request('/api/login', undefined, { email: 'missing@example.com', password: 'wrong' }), 'peer-two')).status).toBe(401);
    access.close();
  });

  test('secure sessions, CSRF rejection, login and logout', async () => {
    const access = createAccess(':memory:');
    const api = createApi({ access, monitoring: monitoringFixture, origin });
    expect((await api(request('/api/session'))).status).toBe(401);
    const owner = await signup(api, 'owner');
    expect(owner.cookie).toContain('HttpOnly');
    expect(owner.cookie).toContain('SameSite=Lax');
    expect(owner.cookie).toContain('Secure');
    const current = await api(request('/api/session', owner.cookie));
    expect(current.status).toBe(200);
    expect(await current.json()).toEqual({ user: owner.user, workspaces: owner.workspaces });
    expect((await api(request('/api/workspaces', owner.cookie, { name: 'CSRF workspace' }, 'https://attacker.example'))).status).toBe(403);
    expect((await api(new Request(`${origin}/api/logout`, { method: 'POST', headers: { Cookie: owner.cookie } }))).status).toBe(403);
    expect((await api(request('/api/signup', undefined, { name: 'attacker', email: 'attacker@example.com', password: 'correct horse battery staple' }, 'https://attacker.example'))).status).toBe(403);
    const logout = await api(request('/api/logout', owner.cookie, {}));
    expect(logout.status).toBe(200);
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0');
    expect((await api(request('/api/session', owner.cookie))).status).toBe(401);
    expect((await api(request('/api/login', undefined, { email: owner.user.email, password: 'wrong' }))).status).toBe(401);
    const login = await api(request('/api/login', undefined, { email: owner.user.email, password: 'correct horse battery staple' }));
    expect(login.status).toBe(200);
    expect(login.headers.get('Set-Cookie')).toContain('HttpOnly');
    access.close();
  });

  test('owner invites a matching email, members share comments, outsiders cannot read shipment state', async () => {
    const access = createAccess(':memory:');
    const api = createApi({ access, monitoring: monitoringFixture, origin });
    const owner = await signup(api, 'owner');
    const member = await signup(api, 'member');
    const outsider = await signup(api, 'outsider');
    const workspace = owner.workspaces[0];
    if (!workspace) throw new Error('Owner workspace missing');
    const path = `/api/workspaces/${workspace.id}`;
    expect((await api(request(`${path}/dashboard`, outsider.cookie))).status).toBe(403);
    expect((await api(request(`${path}/disruptions`, outsider.cookie, { portId: 'singapore', delayHours: 24 }))).status).toBe(403);
    const invited = await api(request(`${path}/invitations`, owner.cookie, { email: member.user.email }));
    expect(invited.status).toBe(200);
    const rawInvite: unknown = await invited.json();
    const invitation = inviteBody.parse(rawInvite);
    const token = new URL(invitation.url).searchParams.get('invite');
    expect(token).toBeTruthy();
    expect((await api(request('/api/invitations/accept', outsider.cookie, { token }))).status).toBe(400);
    const accepted = await api(request('/api/invitations/accept', member.cookie, { token }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ...workspace, role: 'member' });
    expect((await api(request('/api/invitations/accept', member.cookie, { token }))).status).toBe(400);
    expect((await api(request(`${path}/invitations`, member.cookie, { email: outsider.user.email }))).status).toBe(403);
    expect((await api(request(`${path}/dashboard`, member.cookie))).status).toBe(200);
    const roster = await api(request(`${path}/members`, member.cookie));
    expect(await roster.json()).toEqual({ members: [{ ...owner.user, role: 'owner' }, { ...member.user, role: 'member' }] });
    const comments = `${path}/shipments/gz-1042/comments`;
    expect((await api(request(comments, owner.cookie, { body: 'Confirm the arrival window.' }))).status).toBe(200);
    expect((await api(request(comments, member.cookie, { body: 'Consignee has been notified.' }))).status).toBe(200);
    const ownerComments = await api(request(comments, owner.cookie));
    const memberComments = await api(request(comments, member.cookie));
    expect(await ownerComments.json()).toEqual(await memberComments.json());
    expect((await api(request(comments, outsider.cookie))).status).toBe(403);
    expect((await api(request(comments, outsider.cookie, { body: 'Unauthorized comment' }))).status).toBe(403);
    expect((await api(request(`${path}/shipments/unknown/comments`, owner.cookie))).status).toBe(404);
    expect((await api(request(`${path}/shipments/unknown/comments`, member.cookie, { body: 'No such shipment' }))).status).toBe(404);
    access.close();
  });
});
