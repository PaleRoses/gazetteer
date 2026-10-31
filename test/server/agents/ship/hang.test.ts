import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createActorStub, createActorTransport } from 'durable-actors/backend';
import { startLocalActors } from 'durable-actors/dev';
import { demoShipments } from '../../../../src/core/demo';
import type { Disruption } from '../../../../src/core/types';
import type { ShipmentAgent } from '../../../../src/server/agents/ship/agent';
import { emptyInbox } from '../../../../src/server/relay/inbox';

type ShipClient = Pick<ShipmentAgent, 'initialize' | 'join' | 'deliver' | 'check' | 'snapshot'>;
const methods = [{ name: 'initialize', result: 'value' }, { name: 'join', result: 'value' }, { name: 'deliver', result: 'void' }, { name: 'check', result: 'value' }, { name: 'snapshot', result: 'value' }] as const;
const disruption: Disruption = { id: 'hang-test-disruption', portId: 'singapore', delayHours: 36, evidence: { id: 'hang-test-disruption', source: 'simulation', title: 'Berth closure', detail: 'Synthetic.', observedAt: '2026-10-31T20:00:00.000Z' } };

/** A Relay that accepts registration and joining, and can be made to answer reads never. */
function fakeRelay() {
  const hang = { on: false };
  const reply = (data: unknown): Response => Response.json({ ok: true, data });
  const server = Bun.serve({
    port: 0, idleTimeout: 0,
    fetch: async request => {
      const url = new URL(request.url);
      if (hang.on && request.method === 'GET') return new Promise<Response>(() => undefined);
      if (request.method === 'POST' && url.pathname === '/v1/agents') { const body = await request.json() as Record<string, unknown>; return reply({ id: randomUUID(), name: body.name, token: `tok-${randomUUID()}`, type: 'agent', status: 'online', created_at: new Date().toISOString() }); }
      if (url.pathname === '/v1/channels' && request.method === 'GET') return reply([]);
      if (url.pathname === '/v1/channels' && request.method === 'POST') return reply({ name: 'c', topic: null, created_at: new Date().toISOString() });
      if (/\/join$/.test(url.pathname)) return reply({ ok: true });
      if (/\/messages$/.test(url.pathname) && request.method === 'GET') return reply([]);
      return Response.json({ ok: false, error: { code: 'not_found', message: 'unhandled' } }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, hang, stop: () => server.stop(true) };
}

function projectWith(env: Readonly<Record<string, string>>): string {
  const real = resolve(import.meta.dir, '../../../..');
  const project = mkdtempSync(join(tmpdir(), 'gazetteer-project-'));
  ['src', 'node_modules', 'package.json', 'tsconfig.json'].forEach(name => symlinkSync(join(real, name), join(project, name)));
  writeFileSync(join(project, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  return project;
}

test('with Relay hanging, a ship\'s check returns at once and applies the delivered disruption; the history joins when Relay recovers', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gazetteer-hang-'));
  const relay = fakeRelay();
  const project = projectWith({ RELAY_BASE_URL: relay.url, GAZETTEER_DEMO: 'off', GAZETTEER_LIVE_SOURCES: 'off' });
  const runtime = await startLocalActors({ project, projectId: 'gazetteer-hang', entrypoint: 'src/server/agents/index.ts', dataDir, apiKey: randomUUID(), quiet: true });
  try {
    const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion });
    const ship = createActorStub<ShipClient>('ShipmentAgent', 'hang-test-ship', methods, transport);
    const seed = demoShipments(new Date('2026-10-31T12:00:00.000Z'))[0]!;
    expect(await ship.initialize('workspace', seed, 'workspace-key')).toEqual({ status: 'ok', value: null });
    expect(await ship.join('workspace', 'workspace-key', false)).toEqual({ status: 'ok', value: null });
    relay.hang.on = true;
    await ship.deliver({ ...emptyInbox, disruptions: [disruption] });
    const began = performance.now();
    const hung = await ship.check();
    expect(performance.now() - began).toBeLessThan(3_000);
    expect(hung.status).toBe('unavailable');
    expect((await ship.snapshot())?.appliedDisruptions).toContain(disruption.id);
    expect((await ship.snapshot())?.delayHours).toBe(36);
    relay.hang.on = false;
    const recovered = await (async () => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const outcome = await ship.check();
        if (outcome.status === 'ok') return outcome;
        await Bun.sleep(1_000);
      }
      return null;
    })();
    expect(recovered?.status).toBe('ok');
  } finally {
    await runtime.stop();
    relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}, 240_000);
