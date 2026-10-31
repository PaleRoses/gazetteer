import { AgentRelay, type RelayAgentClient, type RelayMessage } from '@agent-relay/sdk';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { relaySuccess, type Disruption, type RelayOutcome } from '../shared';

export type RelayIdentity = Readonly<{ token: string; channel: string }>;
/** Expected provider failures cross actor and HTTP boundaries as data, never fabricated success. */
export async function attemptRelay<A>(operation: () => Promise<A>, message: string): Promise<RelayOutcome<A>> {
  try { return relaySuccess(await operation()); }
  catch { return { status: 'unavailable', message }; }
}
export const relayChannel = (workspaceId: string): string => `gazetteer-${workspaceId}`;

const disruptionSchema = z.object({
  id: z.string(), portId: z.enum(['singapore', 'rotterdam', 'shanghai', 'los-angeles']),
  delayHours: z.number().positive().max(168),
  evidence: z.object({ id: z.string(), source: z.literal('simulation'), title: z.string(), detail: z.string(), observedAt: z.iso.datetime() }),
});

const retryPolicy = { maxRetries: 4, backoffMs: 500, backoffMultiplier: 2, jitter: true };

export async function registerParticipant(workspaceKey: string, name: string, channel: string): Promise<RelayIdentity> {
  const relay = new AgentRelay({ workspaceKey, retryPolicy });
  const registration = await relay.agents.register({ name: `${name}-${randomUUID().slice(0, 8)}`, type: 'agent' });
  return { token: registration.token, channel };
}

const participant = (identity: RelayIdentity): Promise<RelayAgentClient> => new AgentRelay({ agentToken: identity.token, retryPolicy }).workspace.reconnect({ apiToken: identity.token });

export async function joinChannel(identity: RelayIdentity, createChannel: boolean): Promise<void> {
  const client = await participant(identity);
  const channels = createChannel ? await client.channels.list() : [];
  if (createChannel && !channels.some(channel => channel.name === identity.channel)) {
    await client.channels.create({ name: identity.channel, topic: 'Gazetteer synthetic port disruptions. No live shipping information.' });
  } else await client.channels.join(identity.channel);
}

export async function publishDisruption(identity: RelayIdentity, disruption: Disruption): Promise<string> {
  const client = await participant(identity);
  const message = await client.sendMessage({
    to: `#${identity.channel}`, text: disruption.evidence.detail,
    idempotencyKey: disruption.id, metadata: { kind: 'gazetteer.simulated-disruption', source: 'simulation', disruption },
  });
  return message.messageId;
}

/** Relay pages are newest-first. Traverse all pages; never silently lose older disruptions. */
async function channelHistory(client: RelayAgentClient, channel: string, before?: string): Promise<readonly RelayMessage[]> {
  const page = await client.messages.list(channel, { limit: 100, ...(before ? { before } : {}) });
  const oldest = page.at(-1);
  return page.length < 100 || !oldest ? page : [...page, ...await channelHistory(client, channel, oldest.messageId)];
}

export async function readDisruptions(identity: RelayIdentity): Promise<readonly Disruption[]> {
  const client = await participant(identity);
  const messages = await channelHistory(client, identity.channel);
  return messages.flatMap(message => {
    if (message.metadata?.kind !== 'gazetteer.simulated-disruption') return [];
    const parsed = disruptionSchema.safeParse(message.metadata.disruption);
    return parsed.success ? [parsed.data] : [];
  }).toSorted((left, right) => left.evidence.observedAt.localeCompare(right.evidence.observedAt));
}
