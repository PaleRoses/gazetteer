import { relaySuccess, type RelayOutcome } from '../../core/types';
import { attemptRelay, joinChannel, registerParticipant, relayChannel, type RelayIdentity } from './client';

export const connect = (state: Readonly<{ relay: RelayIdentity; ready: boolean }>, createChannel: boolean): Promise<RelayOutcome<null>> =>
  state.ready ? Promise.resolve(relaySuccess(null)) : attemptRelay(async () => {
    await joinChannel(state.relay, createChannel);
    return null;
  }, 'Agent Relay channel is unavailable. Monitoring will retry.');

/**
 * Relay membership, off every actor's readiness path: register once (the identity is remembered the moment it exists, so a restart never
 * registers twice), then join the channel. Fails as data; the server retries it in the background with backoff.
 */
export async function joinRelay(
  state: Readonly<{ relay: RelayIdentity | null }>,
  member: Readonly<{ name: string; workspaceId: string; workspaceKey: string; createChannel: boolean }>,
  remember: (identity: RelayIdentity) => void,
): Promise<RelayOutcome<RelayIdentity>> {
  const registered = state.relay ? relaySuccess(state.relay) : await attemptRelay(() => registerParticipant(member.workspaceKey, member.name, relayChannel(member.workspaceId)), 'Agent Relay registration is unavailable. Monitoring will retry.');
  if (registered.status === 'unavailable') return registered;
  if (!state.relay) remember(registered.value);
  const joined = await connect({ relay: registered.value, ready: false }, member.createChannel);
  return joined.status === 'unavailable' ? joined : relaySuccess(registered.value);
}
