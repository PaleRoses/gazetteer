import type { RelayOutcome } from '../../../core/types';
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
 * What a ship hears this cycle. A synced ship hears its inbox. An unsynced ship also reads the Relay history once; when that read (or the
 * connection it needs) is unavailable it still reacts to its inbox and stays unsynced, so a disruption the server delivered is never ignored
 * for as long as Relay keeps failing.
 */
export async function hear(state: Readonly<{ synced?: boolean; cursor?: Cursor | null }>, heard: Inbox, connection: RelayOutcome<unknown>, history: () => Promise<RelayOutcome<ChannelRead>>): Promise<Hearing> {
  const local: ChannelRead = { board: heard.board, disruptions: heard.disruptions, cursor: state.cursor ?? null };
  if (state.synced) return { channel: local, synced: true, unavailable: null };
  if (connection.status === 'unavailable') return { channel: local, synced: false, unavailable: connection.message };
  const read = await history();
  return read.status === 'ok' ? { channel: unionHeard(read.value, heard), synced: true, unavailable: null } : { channel: local, synced: false, unavailable: read.message };
}
