import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createActorTransport } from 'durable-actors/backend';
import { startLocalActors } from 'durable-actors/dev';
import type { BoardMessage } from '../../../src/core/board';
import { relaySuccess } from '../../../src/core/types';
import { createBookings } from '../../../src/server/booking/ledger';
import { actorClients, createRecovery, type Recovery } from '../../../src/server/runtime/recovery';

/** A Relay that answers the wire protocol enough for three actors to register and join; the server below plays the bus. */
function fakeRelay() {
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
      return Response.json({ ok: false, error: { code: 'not_found', message: 'unhandled' } }, { status: 404 });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

function projectWith(env: Readonly<Record<string, string>>): string {
  const real = resolve(import.meta.dir, '../../..');
  const project = mkdtempSync(join(tmpdir(), 'gazetteer-project-'));
  ['src', 'node_modules', 'package.json', 'tsconfig.json'].forEach(name => symlinkSync(join(real, name), join(project, name)));
  writeFileSync(join(project, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'));
  return project;
}

const workspaceId = 'w1';

test('the cargo agent restarted before it answers the offers it was just sent leaves one ledger row per key, and the case still recovers', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gazetteer-recovery-'));
  const relay = fakeRelay();
  const project = projectWith({ RELAY_BASE_URL: relay.url, GAZETTEER_LIVE_SOURCES: 'off' });
  const bookingsPath = join(dataDir, 'bookings.sqlite');
  const ledger = createBookings(bookingsPath);
  const ship = { id: 'gz-1042', vessel: 'Meridian Star', baselineEta: new Date().toISOString() };
  const board = new Map<string, BoardMessage>();
  let current: Recovery | undefined;

  /** The server's part: every post is heard once, kept, and routed to the actors it is for. */
  const absorb = async (_: string, batch: { board: readonly BoardMessage[] }): Promise<number> => {
    const fresh = batch.board.filter(message => !board.has(message.id));
    fresh.forEach(message => board.set(message.id, message));
    if (fresh.length > 0) await current?.deliver(workspaceId, { board: fresh, disruptions: [] });
    return fresh.length;
  };

  const session = async <A>(operation: (recovery: Recovery) => Promise<A>, probe = true): Promise<A> => {
    const runtime = await startLocalActors({ project, projectId: 'gazetteer-recovery', entrypoint: 'src/server/agents/index.ts', dataDir, apiKey: randomUUID(), quiet: true });
    try {
      const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion });
      const recovery = createRecovery({
        clients: actorClients(transport), workspaceKey: 'workspace-key', bookingsPath, ledger, limit: run => run(),
        meridianStar: async () => ship,
        send: async outgoing => ({ board: outgoing.board.map(message => message.id), disruptions: [], failure: null }),
        absorb, announce: () => undefined, delaysMs: [20],
      });
      current = recovery;
      recovery.begin(workspaceId);
      const ready = async (): Promise<void> => {
        for (let tries = 0; tries < 400; tries += 1) {
          if ((await recovery.restartCargo(workspaceId)).status === 'ok') return;
          await Bun.sleep(25);
        }
        throw new Error('the act 2 actors did not come up');
      };
      if (probe) await ready();
      // The server has the whole board: after a restart it hands the returning actors what it heard.
      if (board.size > 0) await recovery.deliver(workspaceId, { board: [...board.values()], disruptions: [] });
      try { return await operation(recovery); } finally { recovery.close(); }
    } finally { await runtime.stop(); }
  };
  const quiet = async (recovery: Recovery): Promise<void> => {
    for (let round = 0, silent = 0; silent < 2 && round < 24; round += 1) silent = await recovery.step(workspaceId) === 0 ? silent + 1 : 0;
  };

  try {
    await session(async recovery => {
      await recovery.step(workspaceId); // the cargo agent asks
      await recovery.step(workspaceId); // the desk and the haulier answer; the offers are now in the cargo agent's inbox, undecided
      expect([...board.values()].map(message => message.kind)).toContain('recovery.offer');
      expect([...board.values()].some(message => message.kind === 'recovery.hold')).toBe(false);
    });
    await session(async recovery => {
      await quiet(recovery);
      await quiet(recovery);
    });

    const holds = [...board.values()].flatMap(message => message.kind === 'recovery.hold' ? [message] : []);
    const keys = new Set(holds.map(hold => (hold as unknown as { key: string }).key));
    expect(keys.size).toBeGreaterThan(0);
    expect(ledger.list(workspaceId)).toHaveLength(keys.size);
    [...keys].forEach(key => expect(ledger.find(key)).toBeDefined());
    expect(ledger.list(workspaceId).every(row => row.status === 'confirmed')).toBe(true);
    expect([...board.values()].some(message => message.kind === 'recovery.plan')).toBe(true);
    await session(async recovery => {
      await quiet(recovery);
      expect(ledger.list(workspaceId)).toHaveLength(keys.size);
      expect(recovery.view(workspaceId)?.reservations).toHaveLength(keys.size);
      expect((await recovery.withdrawTruck(workspaceId)).status).toBe('ok');
      await quiet(recovery);
      const live = ledger.list(workspaceId).filter(row => row.status === 'held' || row.status === 'confirmed');
      expect(new Set(live.map(row => row.resource)).size).toBe(live.length);
    });
  } finally {
    ledger.close();
    relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}, 240_000);

test('the press carries the negotiation to a confirmed plan by itself: nobody steps the actors, and no minute-long alarm is waited for', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gazetteer-pump-'));
  const relay = fakeRelay();
  const project = projectWith({ RELAY_BASE_URL: relay.url, GAZETTEER_LIVE_SOURCES: 'off' });
  const bookingsPath = join(dataDir, 'bookings.sqlite');
  const ledger = createBookings(bookingsPath);
  const board = new Map<string, BoardMessage>();
  let current: Recovery | undefined;
  const absorb = async (_: string, batch: { board: readonly BoardMessage[] }): Promise<number> => {
    const fresh = batch.board.filter(message => !board.has(message.id));
    fresh.forEach(message => board.set(message.id, message));
    if (fresh.length > 0) await current?.deliver(workspaceId, { board: fresh, disruptions: [] });
    return fresh.length;
  };
  try {
    const runtime = await startLocalActors({ project, projectId: 'gazetteer-pump', entrypoint: 'src/server/agents/index.ts', dataDir, apiKey: randomUUID(), quiet: true });
    try {
      const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion });
      const recovery = createRecovery({
        clients: actorClients(transport), workspaceKey: 'workspace-key', bookingsPath, ledger, limit: run => run(),
        meridianStar: async () => ({ id: 'gz-1042', vessel: 'Meridian Star', baselineEta: new Date().toISOString() }),
        send: async outgoing => ({ board: outgoing.board.map(message => message.id), disruptions: [], failure: null }),
        absorb, announce: () => undefined, delaysMs: [20],
      });
      current = recovery;
      recovery.begin(workspaceId);
      const confirmed = (): boolean => ledger.list(workspaceId).filter(row => row.status === 'confirmed').length >= 3;
      for (let tries = 0; tries < 600 && !(confirmed() && recovery.view(workspaceId)?.case?.delivered); tries += 1) await Bun.sleep(100);
      expect(confirmed()).toBe(true);
      expect(recovery.view(workspaceId)?.case?.delivered).toEqual(expect.any(String));
      const kinds = [...board.values()].map(message => message.kind);
      expect(kinds.filter(kind => kind === 'recovery.request').length).toBeGreaterThanOrEqual(3);
      expect(kinds).toContain('recovery.plan');
      recovery.close();
    } finally { await runtime.stop(); }
  } finally {
    ledger.close();
    relay.stop();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
}, 120_000);
