import { describe, expect, mock, test } from 'bun:test';
import { createRoot } from 'solid-js';
import { createWorkspaceFeed } from '../../src/client/live';
import type { ApiResult } from '../../src/client/api';
import type { Dashboard } from '../../src/core/types';
import { societyDashboard } from './society-fixture';

const staleOutcomes: readonly Readonly<{ name: string; result: ApiResult<Dashboard> }>[] = [
  { name: 'snapshot', result: { ok: true, value: { ...societyDashboard, runtime: 'stale poll fixture' } } },
  { name: 'error', result: { ok: false, error: 'Stale poll error', status: 503 } },
];

describe('workspace feed writer ownership', () => {
  test.each(staleOutcomes)('ignores an old poll $name after equal-time SSE takeover and polling restart', async ({ result: stale }) => {
    const firstRead = Promise.withResolvers<void>();
    const restartedRead = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<ApiResult<Dashboard>>();
    const restarted = Promise.withResolvers<ApiResult<Dashboard>>();
    const streamed: Dashboard = { ...societyDashboard, runtime: 'current stream fixture' };
    const resumed: Dashboard = { ...societyDashboard, runtime: 'resumed poll fixture' };
    const retried: Dashboard = { ...societyDashboard, runtime: 'manual retry fixture' };
    const read = mock((_path: string, _signal: AbortSignal): Promise<ApiResult<Dashboard>> => Promise.resolve({ ok: true, value: retried }))
      .mockImplementationOnce(() => { firstRead.resolve(); return delayed.promise; })
      .mockImplementationOnce(() => { restartedRead.resolve(); return restarted.promise; });
    const stream = Object.assign(new EventTarget(), { readyState: 0, CLOSED: 2 as const, close: (): void => undefined });
    const schedule = mock(setTimeout);
    using scope = createRoot(dispose => ({
      feed: createWorkspaceFeed('fixture-workspace', () => false, { read, stream: () => stream, setTimeout: schedule, clearTimeout }),
      [Symbol.dispose]: dispose,
    }));

    await firstRead.promise;
    stream.dispatchEvent(new Event('open'));
    stream.dispatchEvent(new MessageEvent('dashboard', { data: JSON.stringify(streamed) }));
    expect(scope.feed.dashboard()?.runtime).toBe(streamed.runtime);
    expect(read.mock.calls[0]?.[1].aborted).toBe(true);

    stream.dispatchEvent(new Event('error'));
    await restartedRead.promise;
    expect(read.mock.calls[1]?.[1].aborted).toBe(false);
    delayed.resolve(stale);
    await Bun.sleep(0);
    expect(scope.feed.dashboard()?.runtime).toBe(streamed.runtime);
    expect(scope.feed.error()).toBeNull();
    expect(schedule.mock.calls.filter(([, delay]) => delay === 5_000)).toEqual([]);

    restarted.resolve({ ok: true, value: resumed });
    await Bun.sleep(0);
    expect(scope.feed.dashboard()?.runtime).toBe(resumed.runtime);
    scope.feed.retry();
    await Bun.sleep(0);
    expect(scope.feed.dashboard()?.runtime).toBe(retried.runtime);
  });
});
