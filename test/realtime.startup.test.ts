import { describe, expect, test } from 'bun:test';
import { createLimiter, createStartup, type StartupTask } from '../src/server/realtime/startup';

const pause = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms));
const settled = async (check: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await pause(2);
  }
};

describe('createLimiter', () => {
  test('never runs more than the cap at once, however the work interleaves, and loses no task', async () => {
    const limit = createLimiter(3);
    let active = 0;
    let peak = 0;
    let finished = 0;
    await Promise.all(Array.from({ length: 25 }, (_, index) => limit(async () => {
      active += 1; peak = Math.max(peak, active);
      await pause(index % 4);
      active -= 1; finished += 1;
    })));
    expect(finished).toBe(25);
    expect(peak).toBe(3);
  });
  test('a throwing task frees its slot', async () => {
    const limit = createLimiter(1);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await limit(async () => 'next')).toBe('next');
  });
});

describe('createStartup', () => {
  const noWait = async (): Promise<void> => undefined;

  test('ensure returns at once while every actor is still pending, then progress is reported until complete', async () => {
    const releases = new Map<string, () => void>();
    const tasks: readonly StartupTask[] = ['a', 'b', 'c', 'd'].map(key => ({ key, run: () => new Promise<boolean>(done => { releases.set(key, () => done(true)); }) }));
    const ready: string[] = [];
    const startup = createStartup({ tasksOf: () => tasks, limit: createLimiter(3), onReady: (_, key) => ready.push(key), sleep: noWait });
    const started = Date.now();
    startup.ensure('w');
    expect(Date.now() - started).toBeLessThan(20);
    expect(startup.status('w')).toEqual({ ready: 0, total: 4, complete: false });
    releases.get('a')?.();
    await settled(() => startup.isReady('w', 'a'));
    expect(startup.status('w')).toEqual({ ready: 1, total: 4, complete: false });
    await settled(() => releases.has('d'));
    ['b', 'c', 'd'].forEach(key => releases.get(key)?.());
    await settled(() => startup.status('w').complete);
    expect(ready.toSorted()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('concurrency across tasks and workspaces never exceeds the shared cap', async () => {
    let active = 0;
    let peak = 0;
    const task = (key: string): StartupTask => ({ key, run: async () => { active += 1; peak = Math.max(peak, active); await pause(3); active -= 1; return true; } });
    const startup = createStartup({ tasksOf: () => ['1', '2', '3', '4', '5', '6', '7', '8'].map(task), limit: createLimiter(3), sleep: noWait });
    startup.ensure('w1'); startup.ensure('w2');
    await settled(() => startup.status('w1').complete && startup.status('w2').complete);
    expect(peak).toBe(3);
  });

  test('joiners wait for the channel creator and never start before it is ready', async () => {
    const order: string[] = [];
    let creatorAttempts = 0;
    const tasks: readonly StartupTask[] = [
      { key: 'creator', run: async () => { creatorAttempts += 1; order.push(`creator#${creatorAttempts}`); return creatorAttempts > 1; } },
      { key: 'joiner', after: 'creator', run: async () => { order.push('joiner'); return true; } },
    ];
    const startup = createStartup({ tasksOf: () => tasks, limit: createLimiter(3), sleep: noWait });
    startup.ensure('w');
    await settled(() => startup.status('w').complete);
    expect(order).toEqual(['creator#1', 'creator#2', 'joiner']);
  });

  test('a failing actor is retried with growing, capped backoff until it succeeds, and throws count as failures', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const tasks: readonly StartupTask[] = [{ key: 'flaky', run: async () => { attempts += 1; if (attempts % 2 === 0) throw new Error('relay 503'); return attempts >= 5; } }];
    const startup = createStartup({ tasksOf: () => tasks, limit: createLimiter(3), delaysMs: [10, 20, 40], sleep: async ms => { waits.push(ms); } });
    startup.ensure('w');
    await settled(() => startup.isReady('w', 'flaky'));
    expect(attempts).toBe(5);
    expect(waits).toEqual([10, 20, 40, 40]);
  });

  test('starting is single-flight per workspace and close stops further retries', async () => {
    let listed = 0;
    let attempts = 0;
    const tasks: readonly StartupTask[] = [{ key: 'never', run: async () => { attempts += 1; return false; } }];
    const startup = createStartup({ tasksOf: () => { listed += 1; return tasks; }, limit: createLimiter(3), delaysMs: [1], sleep: async () => { await pause(1); } });
    startup.ensure('w'); startup.ensure('w'); startup.ensure('w');
    await settled(() => attempts >= 3);
    startup.close();
    await pause(10);
    const frozen = attempts;
    await pause(20);
    expect(listed).toBe(1);
    expect(attempts).toBe(frozen);
    expect(startup.status('w').complete).toBe(false);
  });
});
