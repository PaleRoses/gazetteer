import type { RelayAgentClient, RelayMessage } from '@agent-relay/sdk';
import { boardMetadataKind, parseBoardMessage, type BoardMessage } from '../../board';
import type { Disruption, RelayOutcome } from '../../shared';
import { pollSince, type Cursor } from '../realtime/cursor';
import { attemptRelay, disruptionFrom, participant, type RelayIdentity } from '../relay';

export type RelayCursor = Cursor | null;
export type BoardRead = Readonly<{ messages: readonly BoardMessage[]; cursor: RelayCursor }>;
/** One pass over the workspace channel: board posts and disruption notices share a channel, hence a cursor. */
export type ChannelRead = Readonly<{ board: readonly BoardMessage[]; disruptions: readonly Disruption[]; cursor: RelayCursor }>;
type Client = Pick<RelayAgentClient, 'sendMessage'> & Readonly<{ messages: Pick<RelayAgentClient['messages'], 'list'> }>;
type Item = Readonly<{ board: BoardMessage }> | Readonly<{ disruption: Disruption }>;

export const boardFrom = (message: Pick<RelayMessage, 'metadata'>): BoardMessage | undefined =>
  message.metadata?.kind === boardMetadataKind ? parseBoardMessage(message.metadata.message) : undefined;

const itemFrom = (message: RelayMessage): Item | undefined => {
  const board = boardFrom(message);
  if (board) return { board };
  const disruption = disruptionFrom(message);
  return disruption ? { disruption } : undefined;
};

const unavailable = (message: string): RelayOutcome<never> => ({ status: 'unavailable', message });

export const boardTransport = (clientOf: (identity: RelayIdentity) => Promise<Client>) => ({
  /** Idempotent: Relay dedupes on idempotencyKey = message.id, so a retried post never doubles. Returns the Relay message id. */
  postBoard: async (identity: RelayIdentity, message: BoardMessage): Promise<RelayOutcome<string>> => {
    const valid = parseBoardMessage(message);
    if (!valid) return unavailable('Board message is malformed and was not posted.');
    return attemptRelay(async () => {
      const sent = await (await clientOf(identity)).sendMessage({
        to: `#${identity.channel}`, text: valid.summary, idempotencyKey: valid.id,
        metadata: { kind: boardMetadataKind, message: valid },
      });
      return sent.messageId;
    }, 'Agent Relay board is unavailable. Post again on the next check.');
  },
  /** Bounded: only messages past the actor's persisted cursor, oldest first. An unavailable read leaves the cursor untouched. */
  readBoard: (identity: RelayIdentity, cursor: RelayCursor): Promise<RelayOutcome<BoardRead>> => attemptRelay(async () => {
    const client = await clientOf(identity);
    const poll = await pollSince(request => client.messages.list(identity.channel, request), cursor, boardFrom);
    return { messages: poll.items, cursor: poll.cursor };
  }, 'Agent Relay board is unavailable. Reading will retry without changing state.'),
  readChannel: (identity: RelayIdentity, cursor: RelayCursor): Promise<RelayOutcome<ChannelRead>> => attemptRelay(async () => {
    const client = await clientOf(identity);
    const poll = await pollSince(request => client.messages.list(identity.channel, request), cursor, itemFrom);
    return {
      board: poll.items.flatMap(item => 'board' in item ? [item.board] : []),
      disruptions: poll.items.flatMap(item => 'disruption' in item ? [item.disruption] : []),
      cursor: poll.cursor,
    };
  }, 'Agent Relay channel is unavailable. Reading will retry without changing state.'),
});

export const { postBoard, readBoard, readChannel } = boardTransport(participant);
