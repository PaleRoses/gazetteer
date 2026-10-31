import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMonitoring } from '../../../src/server/runtime/monitoring';

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));

test('with Agent Relay off no key is needed, every actor is ready within seconds, and the board is the local log', async () => {
  const saved = process.env.RELAY_WORKSPACE_KEY;
  delete process.env.RELAY_WORKSPACE_KEY;
  const dataDir = mkdtempSync(join(tmpdir(), 'gazetteer-off-'));
  const monitoring = await createMonitoring({ relay: 'off', dataDir: join(dataDir, 'actors'), workspaceIds: [] });
  try {
    const started = Date.now();
    const first = await monitoring.dashboard('w');
    expect(first.status).toBe('ok');
    const ready = async (): Promise<boolean> => { const outcome = await monitoring.dashboard('w'); return outcome.status === 'ok' && outcome.value.startup === undefined; };
    while (!await ready() && Date.now() - started < 30_000) await pause(200);
    expect(Date.now() - started).toBeLessThan(30_000);
    const settled = await monitoring.dashboard('w');
    if (settled.status !== 'ok') throw new Error(settled.message);
    expect(settled.value.relayHealth).toEqual({ state: 'off', since: null, lastPostAt: null });
    expect(settled.value.relayMembership).toBeUndefined();
    const after = await monitoring.simulate('w', 'singapore', 24);
    if (after.status !== 'ok') throw new Error(after.message);
    expect(after.value.board?.length ?? 0).toBeGreaterThan(0);
  } finally {
    await monitoring.close();
    if (saved !== undefined) process.env.RELAY_WORKSPACE_KEY = saved;
    rmSync(dataDir, { recursive: true, force: true });
  }
}, 120_000);
