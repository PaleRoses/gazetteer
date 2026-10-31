import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createActorStub, createActorTransport } from 'durable-actors/backend';
import { startLocalActors } from 'durable-actors/dev';
import type { ShipObservation } from '../../../../src/core/board';
import type { RecoveryMessage } from '../../../../src/core/recovery';
import { portById } from '../../../../src/core/ports';
import type { HazardWatch } from '../../../../src/server/agents/city/hazard-watch';
import type { TerminalDesk } from '../../../../src/server/agents/city/terminal-desk';
import type { TrafficWatch } from '../../../../src/server/agents/city/traffic-watch';
import type { Disruption } from '../../../../src/core/types';

type HazardClient = Pick<HazardWatch, 'initialize' | 'simulate' | 'check' | 'publish' | 'queued'>;
const methods = [
  { name: 'initialize', result: 'value' }, { name: 'simulate', result: 'void' }, { name: 'check', result: 'value' }, { name: 'publish', result: 'value' }, { name: 'queued', result: 'value' },
] as const;
const disruption: Disruption = {
  id: 'restart-test-disruption', portId: 'singapore', delayHours: 6,
  evidence: { id: 'restart-test-disruption', source: 'simulation', title: 'Simulated port congestion', detail: 'Synthetic.', observedAt: '2026-10-31T20:00:00.000Z' },
};

/** A Relay that remembers what it was sent: enough of the wire protocol for a port to register, join and publish. */
function fakeRelay() {
  const sent = new Map<string, unknown>();
  const outage = { down: false };
  const reply = (data: unknown): Response => Response.json({ ok: true, data });
  const server = Bun.serve({
    port: 0,
    fetch: async request => {
      if (outage.down) return Response.json({ ok: false, error: { code: 'unavailable', message: 'down' } }, { status: 503 });
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
  return { url: `http://127.0.0.1:${server.port}`, sent, outage, stop: () => server.stop(true) };
}

/** Actors get their environment from the project's .env, not from this process: a throwaway project that links the real sources and points Relay at the fake. */
function projectWith(env: Readonly<Record<string, string>>): string {
  const real = resolve(import.meta.dir, '../../../..');
  const project = mkdtempSync(join(tmpdir(), 'gazetteer-project-'));
  ['src', 'node_modules', 'package.json', 'tsconfig.json'].forEach(name => symlinkSync(join(real, name), join(project, name)));
  writeFileSync(join(project, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  return project;
}

async function withWatch<A>(project: string, dataDir: string, operation: (port: HazardClient) => Promise<A>): Promise<A> {
  const runtime = await startLocalActors({ project, projectId: 'gazetteer-restart', entrypoint: 'src/server/agents/index.ts', dataDir, apiKey: randomUUID(), quiet: true });
  try {
    const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion });
    return await operation(createActorStub<HazardClient>('HazardWatch', 'restart-test-city-singapore-hazards', methods, transport));
  } finally { await runtime.stop(); }
}

test('a disruption simulated before registration, across a restart, is published exactly once and leaves nothing waiting', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gazetteer-restart-'));
  const relay = fakeRelay();
  const project = projectWith({ RELAY_BASE_URL: relay.url, GAZETTEER_LIVE_SOURCES: 'off' });
  try {
    await withWatch(project, dataDir, async port => {
      await port.simulate(disruption);
      expect(await port.queued()).toBe(1);
    });
    await withWatch(project, dataDir, async port => {
      expect(await port.queued()).toBe(1);
      expect(relay.sent.size).toBe(0);
      expect(await port.initialize('workspace', 'singapore', 'workspace-key', true)).toEqual({ status: 'ok', value: null });
      expect(await port.check()).toEqual({ status: 'ok', value: null });
      expect(await port.publish()).toEqual({ status: 'ok', value: null });
      expect(relay.sent.has(disruption.id)).toBe(true);
      expect(await port.queued()).toBe(0);
      expect(await port.check()).toEqual({ status: 'ok', value: null });
      expect(await port.publish()).toEqual({ status: 'ok', value: null });
    });
    await withWatch(project, dataDir, async port => {
      expect(await port.queued()).toBe(0);
      await port.simulate(disruption);
      expect(await port.check()).toEqual({ status: 'ok', value: null });
      expect(await port.publish()).toEqual({ status: 'ok', value: null });
      expect(await port.queued()).toBe(0);
    });
    expect([...relay.sent.keys()]).toEqual([disruption.id]);
  } finally {
    relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}, 180_000);

type TrafficClient = Pick<TrafficWatch, 'initialize' | 'deliver' | 'check' | 'unpublished'>;
const trafficMethods = [
  { name: 'initialize', result: 'value' }, { name: 'deliver', result: 'void' }, { name: 'check', result: 'value' }, { name: 'unpublished', result: 'value' },
] as const;

test('with Relay down for the whole check, a traffic watch still decides from what was delivered locally and queues its report', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gazetteer-offline-'));
  const relay = fakeRelay();
  const project = projectWith({ RELAY_BASE_URL: relay.url, GAZETTEER_LIVE_SOURCES: 'off' });
  const singapore = portById.get('singapore')!;
  const observedAt = new Date(Date.now() - 3_600_000).toISOString();
  const stopped = (shipmentId: string): ShipObservation => ({
    id: `obs:${shipmentId}`, kind: 'ship.observation', author: { role: 'ship', id: shipmentId, vessel: shipmentId }, at: observedAt, summary: 'stopped',
    shipmentId, signals: ['stationary-outside-port'], position: [singapore.coordinates[0], singapore.coordinates[1] + 0.1], nearPort: 'singapore', provider: 'test', observedAt,
  });
  try {
    const runtime = await startLocalActors({ project, projectId: 'gazetteer-offline', entrypoint: 'src/server/agents/index.ts', dataDir, apiKey: randomUUID(), quiet: true });
    try {
      const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion });
      const watch = createActorStub<TrafficClient>('TrafficWatch', 'offline-test-city-singapore-traffic', trafficMethods, transport);
      expect(await watch.initialize('workspace', 'singapore', 'workspace-key', true)).toEqual({ status: 'ok', value: null });
      relay.outage.down = true;
      await watch.deliver({ board: [stopped('a'), stopped('b')], disruptions: [] });
      expect((await watch.check()).status).toBe('unavailable');
      const queued = (await watch.unpublished())?.board ?? [];
      expect(queued.map(message => message.kind)).toEqual(['city.traffic']);
      expect(queued[0]).toMatchObject({ risk: 'elevated', anchored: 2, evidenceIds: ['obs:a', 'obs:b'] });
      expect(relay.sent.size).toBe(0);
    } finally { await runtime.stop(); }
  } finally {
    relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}, 180_000);

type DeskClient = Pick<TerminalDesk, 'initialize' | 'deliver' | 'check' | 'unpublished'>;
const deskMethods = [
  { name: 'initialize', result: 'value' }, { name: 'deliver', result: 'void' }, { name: 'check', result: 'value' }, { name: 'unpublished', result: 'value' },
] as const;

test('the terminal desk answers from the world\'s Rotterdam windows with Relay down, and its offer waits in the outbox', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gazetteer-desk-'));
  const relay = fakeRelay();
  const project = projectWith({ RELAY_BASE_URL: relay.url, GAZETTEER_LIVE_SOURCES: 'off' });
  const anchor = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString();
  const later = (hours: number): string => new Date(Date.parse(anchor) + hours * 3_600_000).toISOString();
  const ask: RecoveryMessage = {
    id: 'case-1/request/open/unload', kind: 'recovery.request', author: { role: 'cargo', id: 'cargo-1', vessel: 'Meridian Star' }, at: new Date().toISOString(),
    summary: 'An unloading window, please.', caseId: 'case-1', answers: [], to: { role: 'city', city: 'rotterdam', element: 'terminal' }, service: 'unload', after: later(6),
  };
  try {
    const runtime = await startLocalActors({ project, projectId: 'gazetteer-desk', entrypoint: 'src/server/agents/index.ts', dataDir, apiKey: randomUUID(), quiet: true });
    try {
      const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion });
      const desk = createActorStub<DeskClient>('TerminalDesk', 'desk-test-city-rotterdam-terminal', deskMethods, transport);
      expect(await desk.initialize('workspace', 'rotterdam', 'workspace-key', true, join(dataDir, 'bookings.sqlite'), anchor)).toEqual({ status: 'ok', value: null });
      relay.outage.down = true;
      await desk.deliver({ board: [ask], disruptions: [] });
      expect((await desk.check()).status).toBe('unavailable');
      const queued = (await desk.unpublished())?.board ?? [];
      expect(queued).toMatchObject([{ kind: 'recovery.offer', caseId: 'case-1', answers: ['case-1/request/open/unload'], offer: { service: 'unload', at: later(8), priceEur: 140 } }]);
      expect(relay.sent.size).toBe(0);
    } finally { await runtime.stop(); }
  } finally {
    relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}, 180_000);
