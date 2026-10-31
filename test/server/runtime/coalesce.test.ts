import { describe, expect, test } from 'bun:test';
import { createCoalescer } from '../../../src/server/runtime/coalesce';
import { createHub } from '../../../src/server/runtime/hub';
import { fileSeqStore } from '../../../src/server/relay/live';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const gate = () => { let open: () => void = () => undefined; const promise = new Promise<void>(done => { open = done; }); return { promise, open }; };

describe('createCoalescer', () => {
  test('triggers during a run collapse into exactly one trailing run', async () => {
    const first = gate();
    const runs: string[] = [];
    const trigger = createCoalescer(async key => { runs.push(key); if (runs.length === 1) await first.promise; });
    const all = Promise.all([trigger('w1'), trigger('w1'), trigger('w1'), trigger('w1')]);
    expect(runs).toEqual(['w1']);
    first.open();
    await all;
    expect(runs).toEqual(['w1', 'w1']);
    await trigger('w1');
    expect(runs).toHaveLength(3);
  });
  test('keys do not block one another', async () => {
    const hold = gate();
    const runs: string[] = [];
    const trigger = createCoalescer(async key => { runs.push(key); if (key === 'slow') await hold.promise; });
    const slow = trigger('slow');
    await trigger('fast');
    expect(runs).toEqual(['slow', 'fast']);
    hold.open();
    await slow;
  });
  test('a failing run is reported and does not wedge the key', async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const trigger = createCoalescer(async () => { attempts += 1; if (attempts === 1) throw new Error('boom'); }, error => errors.push(error));
    await trigger('w');
    await trigger('w');
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
  });
});

describe('fileSeqStore', () => {
  test('round-trips the latest seq even when saves race', async () => {
    const store = fileSeqStore(join(await mkdtemp(join(tmpdir(), 'gazetteer-seq-')), 'nested', 'relay-seq'));
    expect(await store.load()).toBeUndefined();
    await Promise.all([1, 2, 3, 40, 41].map(store.save));
    expect(await store.load()).toBe(41);
  });
  test('ignores a corrupt file instead of resuming from garbage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'gazetteer-seq-'));
    await Bun.write(join(directory, 'relay-seq'), 'not-a-number');
    expect(await fileSeqStore(join(directory, 'relay-seq')).load()).toBeUndefined();
    expect(await readFile(join(directory, 'relay-seq'), 'utf8')).toBe('not-a-number');
  });
});

describe('createHub.publishDashboard', () => {
  const dashboard = (updatedAt: string, delay: number) => ({ shipments: [{ id: 's', delayHours: delay }], ports: [], updatedAt, mode: 'simulation', runtime: 'r', relay: 'r' }) as never;
  test('publishes only when shipment state changed, not when only the clock did', () => {
    const hub = createHub();
    const seen: unknown[] = [];
    hub.subscribe('w', event => seen.push(event));
    expect(hub.publishDashboard('w', dashboard('t1', 0))).toBe(true);
    expect(hub.publishDashboard('w', dashboard('t2', 0))).toBe(false);
    expect(hub.publishDashboard('w', dashboard('t3', 36))).toBe(true);
    expect(seen).toHaveLength(2);
  });
  test('one throwing consumer does not starve the others', () => {
    const hub = createHub();
    const seen: unknown[] = [];
    hub.subscribe('w', () => { throw new Error('dead socket'); });
    hub.subscribe('w', event => seen.push(event));
    hub.publish('w', { event: 'dashboard', data: dashboard('t', 0) });
    expect(seen).toHaveLength(1);
  });
});
