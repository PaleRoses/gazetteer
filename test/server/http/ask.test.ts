import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { demoShipments } from '../../../src/core/demo';
import { ports } from '../../../src/core/ports';
import { relaySuccess, type Dashboard } from '../../../src/core/types';
import type { ShipAnswer } from '../../../src/server/agents/ship/agent';
import { createAccess } from '../../../src/server/access/access';
import { createApi } from '../../../src/server/http/api';

const origin = 'https://gazetteer.example';
const [meridian] = demoShipments(new Date('2026-10-31T12:00:00.000Z')) as [ReturnType<typeof demoShipments>[number]];
const dashboard: Dashboard = { shipments: [meridian], ports, updatedAt: '2026-10-31T12:00:00.000Z', mode: 'simulation', runtime: 'TEST fixture', relay: 'TEST fixture' };
const authBody = z.object({ workspaces: z.array(z.object({ id: z.string() })) });
const post = (path: string, cookie: string, body: unknown): Request => new Request(`${origin}${path}`, {
  method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const signup = async (api: ReturnType<typeof createApi>, name: string) => {
  const response = await api(new Request(`${origin}/api/signup`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name, email: `${name}@example.com`, password: 'correct horse battery staple' }) }));
  return { cookie: response.headers.get('Set-Cookie') ?? '', ...authBody.parse(await response.json()) };
};
const withMind = (answer: ShipAnswer) => {
  const asked: string[] = [];
  const access = createAccess(':memory:');
  const api = createApi({ access, origin, monitoring: {
    dashboard: async () => relaySuccess(dashboard), simulate: async () => relaySuccess(dashboard),
    ask: async (_workspace, shipment, question) => { asked.push(`${shipment}:${question}`); return answer; },
  } });
  return { access, api, asked };
};

describe('asking a ship mind over HTTP', () => {
  test('a member gets the answer and its citations; a stranger and a malformed question never reach the mind', async () => {
    const { access, api, asked } = withMind({ status: 'answered', answer: 'Singapore is elevated (board-sg-7).', cited: ['board-sg-7'] });
    const owner = await signup(api, 'owner');
    const stranger = await signup(api, 'stranger');
    const path = `/api/workspaces/${owner.workspaces[0]!.id}/shipments/${meridian.id}/ask`;
    const answered = await api(post(path, owner.cookie, { question: 'Why the delay?' }));
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({ answer: 'Singapore is elevated (board-sg-7).', cited: ['board-sg-7'] });
    expect((await api(post(path, stranger.cookie, { question: 'Why the delay?' }))).status).not.toBe(200);
    expect((await api(post(path, owner.cookie, { question: '' }))).status).toBe(400);
    expect((await api(post(path, owner.cookie, { question: 'x'.repeat(501) }))).status).toBe(400);
    expect(asked).toEqual([`${meridian.id}:Why the delay?`]);
    access.close();
  });
  test('an unavailable mind is a 503 that says why', async () => {
    const { access, api } = withMind({ status: 'unavailable', message: 'The ship mind is unavailable until ANTHROPIC_WORKSPACE_ID is set.' });
    const owner = await signup(api, 'owner');
    const response = await api(post(`/api/workspaces/${owner.workspaces[0]!.id}/shipments/${meridian.id}/ask`, owner.cookie, { question: 'Why?' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: expect.stringContaining('ANTHROPIC_WORKSPACE_ID') });
    access.close();
  });
});
