import { AgentRelay, type RelayAgentClient, type RelayMessage } from '@agent-relay/sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { relaySuccess, type Disruption, type RelayOutcome } from '../shared';
import { pollSince, type Cursor } from './realtime/cursor';

/** `agentId` and `agentName` are stored at registration so a client can be built without asking the origin who the token belongs to; identities persisted before that lack them. */
export type RelayIdentity = Readonly<{ token: string; channel: string; agentId?: string; agentName?: string }>;
/** Expected provider failures cross actor and HTTP boundaries as data, never fabricated success. */
/**
 * The SDK honours a server's Retry-After up to 60 s per retry, so its own policy cannot bound the wall clock; this does. An operation
 * that overruns is reported unavailable and the actor moves on (what is still in flight is idempotent or a read).
 */
export const relayDeadlineMs = 15_000;
export async function attemptRelay<A>(operation: () => Promise<A>, message: string, deadlineMs: number = relayDeadlineMs): Promise<RelayOutcome<A>> {
  const timer: { handle?: ReturnType<typeof setTimeout> } = {};
  const expired = new Promise<never>((_resolve, reject) => { timer.handle = setTimeout(() => reject(new Error(`no answer within ${deadlineMs} ms`)), deadlineMs); });
  try { return relaySuccess(await Promise.race([operation(), expired])); }
  catch { return { status: 'unavailable', message }; }
  finally { clearTimeout(timer.handle); }
}
const channelPrefix = 'gazetteer-';
export const relayChannel = (workspaceId: string): string => `${channelPrefix}${workspaceId}`;
export const workspaceOfChannel = (channel: string): string | undefined => channel.startsWith(channelPrefix) ? channel.slice(channelPrefix.length) : undefined;

const disruptionSchema = z.object({
  id: z.string(), portId: z.enum(['singapore', 'rotterdam', 'shanghai', 'los-angeles', 'jebel-ali']),
  delayHours: z.number().positive().max(168).nullable(),
  evidence: z.discriminatedUnion('source', [
    z.object({ id: z.string(), source: z.literal('simulation'), title: z.string(), detail: z.string(), observedAt: z.iso.datetime() }),
    z.object({ id: z.string(), source: z.literal('live'), provider: z.string(), url: z.string(), title: z.string(), detail: z.string(), observedAt: z.iso.datetime() }),
  ]),
  geometry: z.object({ center: z.tuple([z.number(), z.number()]), radiusKm: z.number().nonnegative() }).optional(),
});
const disruptionKinds: readonly unknown[] = ['gazetteer.simulated-disruption', 'gazetteer.live-disruption'];

/** Two retries after the first try, 250 ms then 500 ms apart: a 503 storm costs three requests, not five with multi-second back-offs. */
const retryPolicy = { maxRetries: 2, backoffMs: 250, backoffMultiplier: 2, jitter: true };
/** `RELAY_BASE_URL` points the SDK at another Relay: a self-hosted one, or a local fake in tests. Unset, the SDK's default applies. */
const relayOptions = () => ({ retryPolicy, ...(process.env.RELAY_BASE_URL ? { baseUrl: process.env.RELAY_BASE_URL } : {}) });

export async function registerParticipant(workspaceKey: string, name: string, channel: string): Promise<RelayIdentity> {
  const relay = new AgentRelay({ workspaceKey, ...relayOptions() });
  const registration = await relay.agents.register({ name: `${name}-${randomUUID().slice(0, 8)}`, type: 'agent' });
  return { token: registration.token, channel, agentId: registration.id, agentName: registration.name };
}

type Assembler = Readonly<{ buildAgentClient?: (registration: Readonly<{ id: string; name: string; token: string }>) => RelayAgentClient }>;

/**
 * A client for an agent token. `reconnect` costs a round trip to learn the agent's id and name; when the identity already carries
 * them, the SDK's own assembler builds the client with no network at all (it is the exact code `reconnect` ends in).
 * An SDK without that assembler falls back to `reconnect`.
 */
export const connectParticipant = (identity: RelayIdentity): Promise<RelayAgentClient> => {
  const relay = new AgentRelay({ agentToken: identity.token, ...relayOptions() });
  const assemble = (relay as unknown as Assembler).buildAgentClient;
  return identity.agentId !== undefined && identity.agentName !== undefined && typeof assemble === 'function'
    ? Promise.resolve(assemble.call(relay, { id: identity.agentId, name: identity.agentName, token: identity.token }))
    : relay.workspace.reconnect({ apiToken: identity.token });
};

/** One connected client per token for the life of the process; a failed connection is forgotten so the next call retries it. Concurrent callers share one attempt. */
export const memoizeByToken = <C>(connect: (identity: RelayIdentity) => Promise<C>): ((identity: RelayIdentity) => Promise<C>) => {
  const held = new Map<string, Promise<C>>();
  return identity => {
    const hit = held.get(identity.token);
    if (hit !== undefined) return hit;
    const pending = connect(identity).catch((error: unknown) => { held.delete(identity.token); throw error; });
    held.set(identity.token, pending);
    return pending;
  };
};

export const participant: (identity: RelayIdentity) => Promise<RelayAgentClient> = memoizeByToken(connectParticipant);

export async function joinChannel(identity: RelayIdentity, createChannel: boolean): Promise<void> {
  const client = await participant(identity);
  const channels = createChannel ? await client.channels.list() : [];
  if (createChannel && !channels.some(channel => channel.name === identity.channel)) {
    await client.channels.create({ name: identity.channel, topic: 'Gazetteer port disruptions. Simulated notices say so; live notices carry their provider and URL.' });
  } else await client.channels.join(identity.channel);
}

export async function publishDisruption(identity: RelayIdentity, disruption: Disruption): Promise<string> {
  const client = await participant(identity);
  const message = await client.sendMessage({
    to: `#${identity.channel}`, text: disruption.evidence.detail,
    idempotencyKey: disruption.id, metadata: { kind: disruption.evidence.source === 'live' ? 'gazetteer.live-disruption' : 'gazetteer.simulated-disruption', source: disruption.evidence.source, disruption },
  });
  return message.messageId;
}

export const disruptionFrom = (message: Pick<RelayMessage, 'metadata'>): Disruption | undefined => {
  const { metadata } = message;
  if (metadata === undefined || !disruptionKinds.includes(metadata.kind)) return undefined;
  const parsed = disruptionSchema.safeParse(metadata.disruption);
  return parsed.success ? parsed.data : undefined;
};

export type DisruptionPoll = Readonly<{ disruptions: readonly Disruption[]; cursor: Cursor | null; complete: boolean }>;
/** Bounded read: only messages past the persisted cursor, never the whole channel history. */
export async function readDisruptionsSince(identity: RelayIdentity, cursor: Cursor | null): Promise<DisruptionPoll> {
  const client = await participant(identity);
  const poll = await pollSince(request => client.messages.list(identity.channel, request), cursor, disruptionFrom, undefined, undefined, value => disruptionFrom({ metadata: { kind: 'gazetteer.simulated-disruption', disruption: value } }));
  return { disruptions: poll.items, cursor: poll.cursor, complete: poll.complete };
}
