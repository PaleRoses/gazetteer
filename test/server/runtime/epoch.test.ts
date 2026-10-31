import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoShipments } from '../../../src/core/demo';
import { scenarioEpoch } from '../../../src/server/runtime/epoch';

const etas = (epoch: Date): readonly string[] => demoShipments(epoch).map(ship => `${ship.id}@${ship.eta}`);

test('two processes on one data directory seed identical ETAs, however late the second starts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gazetteer-epoch-'));
  try {
    const file = join(dir, 'scenario-epoch');
    const first = await scenarioEpoch(file, () => 1_800_000_000_000);
    const second = await scenarioEpoch(file, () => 1_800_000_240_000);
    expect(second.getTime()).toBe(first.getTime());
    expect(etas(second)).toEqual(etas(first));
    expect(await readFile(file, 'utf8')).toBe('1800000000000');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('racing first starts agree on one epoch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gazetteer-epoch-'));
  try {
    const file = join(dir, 'scenario-epoch');
    const epochs = await Promise.all([1, 2, 3, 4, 5].map(step => scenarioEpoch(file, () => 1_800_000_000_000 + step * 1000)));
    expect(new Set(epochs.map(epoch => epoch.getTime())).size).toBe(1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a corrupt epoch file is not trusted as a date', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gazetteer-epoch-'));
  try {
    const file = join(dir, 'scenario-epoch');
    await Bun.write(file, 'not a number');
    const epoch = await scenarioEpoch(file, () => 1_800_000_000_000);
    expect(Number.isNaN(epoch.getTime())).toBe(false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
