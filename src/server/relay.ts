import { AgentRelay, type RelayAgentClient, type RelayMessage } from '@agent-relay/sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { relaySuccess, type Disruption, type RelayOutcome } from '../shared';
import { pollSince, type Cursor } from './realtime/cursor';

export type RelayIdentity = Readonly<{ token: string; channel: string }>;
/** Expected provider failures cross actor and HTTP boundaries as data, never fabricated success. */
export async function attemptRelay<A>(operation: () => Promise<A>, message: string): Promise<RelayOutcome<A>> {
  try { return relaySuccess(await operation()); }
  catch { return { status: 'unavailable', message }; }
}
const channelPrefix = 'gazetteer-';
export const relayChannel = (workspaceId: string): string => `${channelPrefix}${workspaceId}`;
export const workspaceOfChannel = (channel: string): string | undefined => channel.startsWith(channelPrefix) ? channel.slice(channelPrefix.length) : undefined;

const disruptionSchema = z.object({
  id: z.string(), portId: z.enum(['singapore', 'rotterdam', 'shanghai', 'los-angeles']),
  delayHours: z.number().positive().max(168).nullable(),
  evidence: z.discriminatedUnion('source', [
    z.object({ id: z.string(), source: z.literal('simulation'), title: z.string(), detail: z.string(), observedAt: z.iso.datetime() }),
    z.object({ id: z.string(), source: z.literal('live'), provider: z.string(), url: z.string(), title: z.string(), detail: z.string(), observedAt: z.iso.datetime() }),
  ]),
  geometry: z.object({ center: z.tuple([z.number(), z.number()]), radiusKm: z.number().nonnegative() }).optional(),
});
const disruptionKinds: readonly unknown[] = ['gazetteer.simulated-disruption', 'gazetteer.live-disruption'];

const retryPolicy = { maxRetries: 4, backoffMs: 500, backoffMultiplier: 2, jitter: true };

export async function registerParticipant(workspaceKey: string, name: string, channel: string): Promise<RelayIdentity> {
  const relay = new AgentRelay({ workspaceKey, retryPolicy });
  const registration = await relay.agents.register({ name: `${name}-${randomUUID().slice(0, 8)}`, type: 'agent' });
  return { token: registration.token, channel };
}

export const participant = (identity: RelayIdentity): Promise<RelayAgentClient> => new AgentRelay({ agentToken: identity.token, retryPolicy }).workspace.reconnect({ apiToken: identity.token });

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
  const poll = await pollSince(request => client.messages.list(identity.channel, request), cursor, disruptionFrom);
  return { disruptions: poll.items, cursor: poll.cursor, complete: poll.complete };
}
