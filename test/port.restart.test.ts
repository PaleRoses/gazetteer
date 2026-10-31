import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createActorStub, createActorTransport } from 'durable-actors/backend';
import { startLocalActors } from 'durable-actors/dev';
import type { PortAgent } from '../src/server/actors';
import type { Disruption } from '../src/shared';

type PortClient = Pick<PortAgent, 'initialize' | 'simulate' | 'check' | 'queued'>;
const methods = [
  { name: 'initialize', result: 'value' }, { name: 'simulate', result: 'void' }, { name: 'check', result: 'value' }, { name: 'queued', result: 'value' },
] as const;
const disruption: Disruption = {
  id: 'restart-test-disruption', portId: 'singapore', delayHours: 6,
  evidence: { id: 'restart-test-disruption', source: 'simulation', title: 'Simulated port congestion', detail: 'Synthetic.', observedAt: '2026-10-31T20:00:00.000Z' },
};

/** A Relay that remembers what it was sent: enough of the wire protocol for a port to register, join and publish. */
function fakeRelay() {
  const sent = new Map<string, unknown>();
  const reply = (data: unknown): Response => Response.json({ ok: true, data });
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      const url = new URL(request.url);
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) as Record<string, unknown> : {};
      if (request.method === 'POST' && url.pathname === '/v1/agents') return reply({ id: randomUUID(), name: body.name, token: `tok-${randomUUID()}`, type: 'agent', status: 'online', created_at: new Date().toISOString() });
      if (url.pathname === '/v1/channels' && request.method === 'GET') return reply([]);
      if (url.pathname === '/v1/channels' && request.method === 'POST') return reply({ name: body.name, topic: body.topic ?? null, created_at: new Date().toISOString() });
      if (/\/v1\/channels\/[^/]+\/join$/.test(url.pathname)) return reply({ ok: true });
      if (/\/v1\/channels\/[^/]+\/messages$/.test(url.pathname) && request.method === 'GET') return reply([]);
      if (request.method === 'POST' && /messages$/.test(url.pathname)) {
        const key = request.headers.get('Idempotency-Key') ?? String(body.idempotencyKey ?? randomUUID());
        sent.set(key, body);
        return reply({ id: `m-${[...sent.keys()].indexOf(key) + 1}`, text: body.text, created_at: new Date().toISOString() });
      }
      return Response.json({ ok: false, error: { code: 'not_found', message: 'unhandled' } }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, sent, stop: () => server.stop(true) };
}

/** Actors get their environment from the project's .env, not from this process: a throwaway project that links the real sources and points Relay at the fake. */
function projectWith(env: Readonly<Record<string, string>>): string {
  const real = resolve(import.meta.dir, '..');
  const project = mkdtempSync(join(tmpdir(), 'gazetteer-project-'));
  ['src', 'node_modules', 'package.json', 'tsconfig.json'].forEach(name => symlinkSync(join(real, name), join(project, name)));
  writeFileSync(join(project, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  return project;
}

async function withPort<A>(project: string, dataDir: string, operation: (port: PortClient) => Promise<A>): Promise<A> {
  const runtime = await startLocalActors({ project, projectId: 'gazetteer-restart', entrypoint: 'src/server/actors.ts', dataDir, apiKey: randomUUID(), quiet: true });
  try {
    const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion });
    return await operation(createActorStub<PortClient>('PortAgent', 'restart-test-port-singapore', methods, transport));
  } finally { await runtime.stop(); }
}

test('a disruption simulated before registration, across a restart, is published exactly once and leaves nothing waiting', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gazetteer-restart-'));
  const relay = fakeRelay();
  const project = projectWith({ RELAY_BASE_URL: relay.url, GAZETTEER_LIVE_SOURCES: 'off' });
  try {
    await withPort(project, dataDir, async port => {
      await port.simulate(disruption);
      expect(await port.queued()).toBe(1);
    });
    await withPort(project, dataDir, async port => {
      expect(await port.queued()).toBe(1);
      expect(relay.sent.size).toBe(0);
      expect(await port.initialize('workspace', 'singapore', 'workspace-key', true)).toEqual({ status: 'ok', value: null });
      expect(await port.check()).toEqual({ status: 'ok', value: null });
      expect(relay.sent.has(disruption.id)).toBe(true);
      expect(await port.queued()).toBe(0);
      expect(await port.check()).toEqual({ status: 'ok', value: null });
    });
    await withPort(project, dataDir, async port => {
      expect(await port.queued()).toBe(0);
      await port.simulate(disruption);
      expect(await port.check()).toEqual({ status: 'ok', value: null });
      expect(await port.queued()).toBe(0);
    });
    expect([...relay.sent.keys()]).toEqual([disruption.id]);
  } finally {
    relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}, 180_000);
