import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { demoShipments } from '../../../src/core/demo';
import { ports } from '../../../src/core/ports';
import { relaySuccess, type Dashboard } from '../../../src/core/types';
import { createAccess } from '../../../src/server/access/access';
import { createApi } from '../../../src/server/http/api';
import type { Monitoring } from '../../../src/server/runtime/monitoring';

const origin = 'https://gazetteer.example';
const dashboard: Dashboard = {
  shipments: demoShipments(new Date('2026-10-31T12:00:00.000Z')), ports,
  updatedAt: '2026-10-31T12:00:00.000Z', mode: 'simulation',
  runtime: 'TEST fixture — no Terse runtime', relay: 'TEST fixture — no Relay connection',
};
// HTTP authorization contract only. Actor/Relay integration is tested by its actual runtime owner.
const monitoringFixture: Pick<Monitoring, 'dashboard' | 'simulate'> = {
  dashboard: async () => relaySuccess(dashboard),
  simulate: async () => relaySuccess(dashboard),
};
const authBody = z.object({ user: z.object({ id: z.string(), name: z.string(), email: z.string() }), workspaces: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['owner', 'member']) })) });
const inviteBody = z.object({ email: z.string(), url: z.string().url(), delivery: z.literal('link-only') });
const submittedInviteBody = z.discriminatedUnion('delivery', [
  z.object({ email: z.string(), url: z.string().url(), delivery: z.literal('accepted'), messageId: z.string() }),
  z.object({ email: z.string(), url: z.string().url(), delivery: z.literal('unconfirmed'), warning: z.string() }),
]);
const mailCases: readonly Readonly<{ name: string; response: () => Promise<Response>; delivery: 'accepted' | 'unconfirmed' }>[] = [
  { name: 'provider receipt', response: async () => Response.json({ id: 'test-message-id' }), delivery: 'accepted' },
  { name: 'missing receipt', response: async () => Response.json({}), delivery: 'unconfirmed' },
  { name: 'empty receipt', response: async () => Response.json({ id: ' ' }), delivery: 'unconfirmed' },
  { name: 'invalid JSON', response: async () => new Response('not JSON'), delivery: 'unconfirmed' },
  { name: 'provider rejection', response: async () => Response.json({ message: 'TEST rejected' }, { status: 403 }), delivery: 'unconfirmed' },
  { name: 'network failure', response: () => Promise.reject(new Error('TEST network failure')), delivery: 'unconfirmed' },
];
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
  test('provider unavailability retains its retry outcome at the HTTP boundary', async () => {
    const access = createAccess(':memory:');
    const unavailable = { status: 'unavailable', message: 'The disruption remains queued for retry.' } as const;
    const api = createApi({ access, origin, monitoring: { dashboard: async () => unavailable, simulate: async () => unavailable } });
    const owner = await signup(api, 'owner');
    const workspace = owner.workspaces[0];
    if (!workspace) throw new Error('Missing test workspace');
    const response = await api(request(`/api/workspaces/${workspace.id}/disruptions`, owner.cookie, { portId: 'singapore', delayHours: 36 }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: unavailable.message });
    access.close();
  });

  test.each(mailCases)('reports $name honestly and retains an email-bound usable link', async ({ response, delivery }) => {
    const access = createAccess(':memory:');
    const api = createApi({ access, monitoring: monitoringFixture, origin,
      mail: { key: 'TEST credential', from: 'Gazetteer <sender@example.com>' },
      mailTransport: async outgoing => {
        expect(outgoing.url).toBe('https://api.resend.com/emails');
        expect(outgoing.headers.get('Authorization')).toBe('Bearer TEST credential');
        expect(outgoing.headers.get('Idempotency-Key')).toBeTruthy();
        const payload: unknown = await outgoing.json();
        const message = z.object({ from: z.string(), to: z.array(z.string()), text: z.string() }).parse(payload);
        expect(message.from).toBe('Gazetteer <sender@example.com>');
        expect(message.to).toEqual(['member@example.com']);
        expect(message.text).toContain('Shipment information is synthetic demo data.');
        return response();
      },
    });
    const owner = await signup(api, 'owner');
    const workspace = owner.workspaces[0];
    if (!workspace) throw new Error('Owner workspace missing');
    const invited = await api(request(`/api/workspaces/${workspace.id}/invitations`, owner.cookie, { email: 'MEMBER@example.com' }));
    expect(invited.status).toBe(200);
    const payload: unknown = await invited.json();
    const invitation = submittedInviteBody.parse(payload);
    expect(invitation.delivery).toBe(delivery);
    if (invitation.delivery === 'accepted') expect(invitation.messageId).toBe('test-message-id');
    else expect(invitation.warning).toContain('unconfirmed');
    const member = await signup(api, 'member');
    const token = new URL(invitation.url).searchParams.get('invite');
    expect((await api(request('/api/invitations/accept', member.cookie, { token }))).status).toBe(200);
    access.close();
  });

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
    const sharedComments: unknown = await ownerComments.json();
    expect(sharedComments).toEqual(await memberComments.json());
    expect((await api(request(comments, outsider.cookie))).status).toBe(403);
    expect((await api(request(comments, outsider.cookie, { body: 'Unauthorized comment' }))).status).toBe(403);
    const separateWorkspace = outsider.workspaces[0];
    if (!separateWorkspace) throw new Error('Outsider workspace missing');
    const separateComments = `/api/workspaces/${separateWorkspace.id}/shipments/gz-1042/comments`;
    expect(await (await api(request(separateComments, outsider.cookie))).json()).toEqual({ comments: [] });
    expect((await api(request(separateComments, outsider.cookie, { body: 'A separate workspace discussion.' }))).status).toBe(200);
    expect(await (await api(request(comments, owner.cookie))).json()).toEqual(sharedComments);
    expect((await api(request(`${path}/shipments/unknown/comments`, owner.cookie))).status).toBe(404);
    expect((await api(request(`${path}/shipments/unknown/comments`, member.cookie, { body: 'No such shipment' }))).status).toBe(404);
    access.close();
  });
});

describe('the ingest view', () => {
  const status = {
    running: true, provenance: 'live', source: 'test', startedAt: '2026-10-31T12:00:00.000Z', lastMessageAt: '2026-10-31T12:00:05.000Z',
    messagesPerSecond: 33, received: 165, invalid: 1, activeVessels: 300, trackedMmsi: 0, countedVessels: 2, unclassified: 9,
    areas: { helsinki: { anchored: 1, berthed: 1, approach: 0 } },
  } as const;

  test('is readable without a session, reports the feed and the zone counts, and says nothing when ingest is off', async () => {
    const access = createAccess(':memory:');
    const body = z.object({ feeds: z.array(z.object({ provider: z.string(), live: z.boolean(), msgPerSec: z.number(), trackedVessels: z.number(), lastMessageAt: z.string().nullable() })), zones: z.array(z.object({ id: z.string(), anchored: z.number() })) });
    const on = createApi({ access, monitoring: monitoringFixture, origin, ingest: () => status });
    const reply = await on(new Request(`${origin}/api/ingest`));
    expect(reply.status).toBe(200);
    expect(body.parse(await reply.json())).toMatchObject({ feeds: [{ provider: 'digitraffic', live: true, msgPerSec: 33, trackedVessels: 300 }], zones: [{ id: 'helsinki', anchored: 1 }] });
    const off = await createApi({ access, monitoring: monitoringFixture, origin })(new Request(`${origin}/api/ingest`));
    expect(await off.json()).toEqual({ feeds: [], zones: [] });
    access.close();
  });
});
