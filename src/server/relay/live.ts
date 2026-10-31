import type { RelayMessage } from '@agent-relay/sdk';
import { createObserverEventSource, createObserverToken, revokeObserverToken } from '@agent-relay/sdk/messaging';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { relaySuccess, type RelayOutcome } from '../../core/types';

export type LiveMessage = Readonly<{ channel: string; message: RelayMessage }>;
export type LiveOptions = Readonly<{
  workspaceKey: string;
  onMessage: (message: LiveMessage) => void;
  /** Resume point from the previous run; the SDK backfills the durable log after it. */
  sinceSeq?: number;
  onCursor?: (seq: number) => void;
  onError?: (error: unknown) => void;
  tokenTtlMs?: number;
}>;
export type Live = Readonly<{ close(): Promise<void> }>;

const weekMs = 7 * 24 * 3_600_000;

/** Relay answers 503 database_overloaded under load: retry transient failures with doubling delay. */
const retrying = async <A>(operation: () => Promise<A>, delaysMs: readonly number[]): Promise<A> => {
  try { return await operation(); }
  catch (error) {
    const [delay, ...rest] = delaysMs;
    if (delay === undefined) throw error;
    await new Promise(done => setTimeout(done, delay));
    return retrying(operation, rest);
  }
};

/**
 * Relay's /v1/ws answers 401 to an Authorization header (probed from Bun and Node on 2026-10-31) and accepts
 * `?token=`. The SDK only falls back to the query form in browsers, so hand it a socket that always uses it.
 */
export const queryTokenSocket = (token: string): typeof WebSocket => class extends WebSocket {
  constructor(url: string | URL) {
    const target = new URL(url);
    target.searchParams.set('token', token);
    super(target);
  }
} as unknown as typeof WebSocket;

/**
 * Observer plane of Agent Relay: a read-only `ot_live_` token follows the workspace's durable event log.
 * The SDK source buffers live frames, backfills `GET /v1/workspace/events` from `sinceSeq`, dedupes by seq,
 * reconnects with capped backoff and repeats the backfill on every socket reopen, so a drop neither loses
 * nor repeats events. Events are doorbells: authoritative state is always re-read through the cursor module.
 */
export async function startRelayLive(options: LiveOptions): Promise<RelayOutcome<Live>> {
  const onError = options.onError ?? (() => undefined);
  try {
    const minted = await retrying(() => createObserverToken({
      workspaceKey: options.workspaceKey, name: `gazetteer-hub-${randomUUID().slice(0, 8)}`,
      description: 'Gazetteer server: read-only follower of port notices',
      scopes: ['stream:read', 'messages:read', 'channels:read'],
      expiresAt: new Date(Date.now() + (options.tokenTtlMs ?? weekMs)).toISOString(),
    }), [500, 1500, 4000]);
    if (!minted.token) return { status: 'unavailable', message: 'Agent Relay did not return an observer token.' };
    const events = createObserverEventSource({
      observerToken: minted.token, onError, webSocketImpl: queryTokenSocket(minted.token),
      ...(options.sinceSeq === undefined ? {} : { sinceSeq: options.sinceSeq }),
      ...(options.onCursor ? { onCursor: options.onCursor } : {}),
    });
    const stop = events.on('messageCreated', ({ channel, message }) => options.onMessage({ channel: channel.replace(/^#/, ''), message }));
    events.connect();
    return relaySuccess({
      close: async () => {
        stop();
        await events.disconnect().catch(onError);
        await revokeObserverToken({ workspaceKey: options.workspaceKey, id: minted.id }).catch(onError);
      },
    });
  } catch (error) {
    onError(error);
    return { status: 'unavailable', message: 'Agent Relay live subscription is unavailable. Polling continues through the actors.' };
  }
}

/** Plain-file seq store: the resume cursor must survive a restart, a lost write only costs a re-backfill. */
export const fileSeqStore = (path: string) => {
  let queue: Promise<void> = Promise.resolve();
  return {
    load: async (): Promise<number | undefined> => {
      const value = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10);
      return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    },
    /** Writes are serialised so the temp file is never shared by two writers. */
    save: (seq: number): Promise<void> => {
      queue = queue.then(async () => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, String(seq), { mode: 0o600 });
        await rename(`${path}.tmp`, path);
      }).catch(() => undefined);
      return queue;
    },
  };
};
