import type { NoticeProvider } from './notice';

export type FetchJson =
  | Readonly<{ status: 'ok'; value: unknown }>
  | Readonly<{ status: 'unavailable'; message: string }>;
export type Fetcher = typeof fetch;

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** The only effect in the sources layer: a timed GET that reports failure as data. */
export const getJson = (provider: NoticeProvider, url: string, userAgent: string, fetcher: Fetcher, timeoutMs: number): Promise<FetchJson> =>
  fetcher(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json, application/geo+json' }, signal: AbortSignal.timeout(timeoutMs) })
    .then(async (response): Promise<FetchJson> => response.ok
      ? { status: 'ok', value: await response.json() as unknown }
      : { status: 'unavailable', message: `${provider} answered HTTP ${response.status}.` })
    .catch((error: unknown): FetchJson => ({ status: 'unavailable', message: `${provider} is unreachable: ${describe(error)}` }));
