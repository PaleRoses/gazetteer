import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createActorStub, createActorTransport } from 'durable-actors/backend';
import { startLocalActors } from 'durable-actors/dev';
import type { PortAgent } from '../../../../src/server/agents/port/agent';
import type { Disruption } from '../../../../src/core/types';

type PortClient = Pick<PortAgent, 'simulate' | 'queued'>;
const disruption = (id: string, portId: Disruption['portId']): Disruption => ({
  id, portId, delayHours: 6,
  evidence: { id, source: 'simulation', title: 'Simulated port congestion', detail: 'Synthetic.', observedAt: '2026-10-31T20:00:00.000Z' },
});

/** One local runtime over `dataDir`, stopped when the operation ends: the next call is a process restart over the same storage. */
async function withPort<A>(dataDir: string, operation: (port: PortClient) => Promise<A>): Promise<A> {
  const runtime = await startLocalActors({ project: resolve(import.meta.dir, '../../../..'), projectId: 'gazetteer-durable', entrypoint: 'src/server/agents/index.ts', dataDir, apiKey: randomUUID(), quiet: true });
  try {
    const transport = createActorTransport({ projectId: runtime.connection.projectId, controlPlaneUrl: runtime.connection.controlPlaneUrl, apiKey: runtime.connection.apiKey, homeRegion: runtime.connection.storageRegion });
    return await operation(createActorStub<PortClient>('PortAgent', 'durable-test-port-singapore', [{ name: 'simulate', result: 'void' }, { name: 'queued', result: 'value' }], transport));
  } finally { await runtime.stop(); }
}

test('a disruption simulated before the port is registered with Relay survives a restart, once', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'gazetteer-durable-'));
  try {
    await withPort(dataDir, async port => {
      expect(await port.queued()).toBe(0);
      await port.simulate(disruption('first', 'singapore'));
      await port.simulate(disruption('first', 'singapore'));
      await port.simulate(disruption('second', 'singapore'));
      await port.simulate(disruption('elsewhere', 'rotterdam'));
      expect(await port.queued()).toBe(2);
    });
    await withPort(dataDir, async port => {
      expect(await port.queued()).toBe(2);
      await port.simulate(disruption('first', 'singapore'));
      expect(await port.queued()).toBe(2);
    });
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
}, 120_000);
