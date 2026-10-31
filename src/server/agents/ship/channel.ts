import type { ChannelRead } from '../../relay/board';
import type { Cursor } from '../../relay/cursor';
import type { Inbox } from '../../relay/inbox';

export type Hearing = Readonly<{
  /** Always readable: what the ship was handed locally is never thrown away because Relay's history was out of reach. */
  channel: ChannelRead;
  /** True once the Relay history has been read, or was not needed. An unsynced ship keeps trying to read it. */
  synced: boolean;
  /** Why the history was out of reach, when it was: the ship says so in its outcome while still acting on its inbox. */
  unavailable: string | null;
}>;

/** A read plus whatever the server already handed over: local echoes may not have reached Relay yet. */
const unionHeard = (read: ChannelRead, heard: Inbox): ChannelRead => ({
  ...read,
  board: [...new Map([...read.board, ...heard.board].map(message => [message.id, message] as const)).values()],
  disruptions: [...new Map([...read.disruptions, ...heard.disruptions].map(item => [item.id, item] as const)).values()],
});

/**
 * What a ship hears this cycle, without waiting on anyone. A synced ship hears its inbox. An unsynced ship hears its inbox plus the Relay
 * history if that has arrived by now (`arrived`); otherwise it acts on the inbox alone, stays unsynced, and says why. A disruption the server
 * delivered is therefore never ignored while Relay is slow or down.
 */
export function hear(state: Readonly<{ synced?: boolean; cursor?: Cursor | null }>, heard: Inbox, arrived: ChannelRead | null, pending: string | null): Hearing {
  const local: ChannelRead = { board: heard.board, disruptions: heard.disruptions, cursor: state.cursor ?? null };
  if (state.synced) return { channel: local, synced: true, unavailable: null };
  return arrived ? { channel: unionHeard(arrived, heard), synced: true, unavailable: null } : { channel: local, synced: false, unavailable: pending ?? 'Relay history is still being read.' };
}
