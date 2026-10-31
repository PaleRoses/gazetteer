/** Manual live probe (not part of the test suite): bun src/server/realtime/probe.ts — uses a throwaway channel. */
import { AgentRelay } from '@agent-relay/sdk';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startRelayLive } from './live';

const workspaceKey = /^RELAY_WORKSPACE_KEY=(.+)$/m.exec(await readFile('.env', 'utf8'))?.[1]?.trim();
if (!workspaceKey) throw new Error('RELAY_WORKSPACE_KEY missing');
const suffix = randomUUID().slice(0, 8);
const channel = `gazetteer-lane-probe-${suffix}`;
const resolvedAt = new Map<string, number>();
const received: Array<{ n: unknown; id: string; channel: string; afterSendResolvedMs: number | null; seq: number | null }> = [];
let lastSeq: number | null = null;
const startedAt = Date.now();
const live = await startRelayLive({
  workspaceKey, onCursor: seq => { lastSeq = seq; },
  onError: error => console.log('live error', error instanceof Error ? error.message.slice(0, 120) : 'non-error'),
  onMessage: ({ channel: name, message }) => {
    if (name !== channel) return;
    const n = String(message.metadata?.n);
    const resolved = resolvedAt.get(n);
    received.push({ n: message.metadata?.n, id: message.messageId, channel: name, afterSendResolvedMs: resolved === undefined ? null : Date.now() - resolved, seq: lastSeq });
  },
});
if (live.status !== 'ok') throw new Error(live.message);
console.log('live ready in', Date.now() - startedAt, 'ms');
const relay = new AgentRelay({ workspaceKey, retryPolicy: { maxRetries: 2, backoffMs: 300, backoffMultiplier: 2, jitter: true } });
const pub = await relay.workspace.register({ name: `probe-pub-${suffix}`, type: 'agent' });
await pub.channels.create({ name: channel, topic: 'lane probe' });
for (const n of [1, 2, 3]) {
  const sentAt = Date.now();
  await pub.sendMessage({ to: `#${channel}`, text: `probe ${n}`, idempotencyKey: `probe-${suffix}-${n}`, metadata: { kind: 'gazetteer.probe', n } });
  resolvedAt.set(String(n), Date.now());
  console.log('send', n, 'resolved in', Date.now() - sentAt, 'ms');
}
await new Promise(done => setTimeout(done, 6000));
console.log('received', JSON.stringify(received));
await live.value.close();
process.exit(0);
