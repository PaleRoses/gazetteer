import type { RelayAgentClient, RelayMessage } from '@agent-relay/sdk';
import { boardMetadataKind, parseBoardMessage, type BoardMessage } from '../../core/board';
import type { Disruption, RelayOutcome } from '../../core/types';
import { pollSince, type Cursor } from './cursor';
import { attemptRelay, disruptionFrom, participant, type RelayIdentity } from './client';

export type RelayCursor = Cursor | null;
export type BoardRead = Readonly<{ messages: readonly BoardMessage[]; cursor: RelayCursor }>;
/** One pass over the workspace channel: board posts and disruption notices share a channel, hence a cursor. */
export type ChannelRead = Readonly<{ board: readonly BoardMessage[]; disruptions: readonly Disruption[]; cursor: RelayCursor }>;
type Client = Pick<RelayAgentClient, 'sendMessage'> & Readonly<{ messages: Pick<RelayAgentClient['messages'], 'list'> }>;
type Item = Readonly<{ board: BoardMessage }> | Readonly<{ disruption: Disruption }>;

export const boardFrom = (message: Pick<RelayMessage, 'metadata'>): BoardMessage | undefined =>
  message.metadata?.kind === boardMetadataKind ? parseBoardMessage(message.metadata.message) : undefined;

/** Items held in a persisted descent come back as plain JSON: re-validate them like fresh messages. */
const reviveItem = (value: unknown): Item | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  if ('board' in value) { const board = parseBoardMessage(value.board); return board ? { board } : undefined; }
  if ('disruption' in value) { const disruption = disruptionFrom({ metadata: { kind: 'gazetteer.simulated-disruption', disruption: value.disruption } }); return disruption ? { disruption } : undefined; }
  return undefined;
};

const itemFrom = (message: RelayMessage): Item | undefined => {
  const board = boardFrom(message);
  if (board) return { board };
  const disruption = disruptionFrom(message);
  return disruption ? { disruption } : undefined;
};

const isAlreadyPosted = (error: unknown): boolean => typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 409;
/** Relay may keep two copies when a retry races a timeout; a board id is one fact, first copy wins. */
const distinctById = (messages: readonly BoardMessage[]): readonly BoardMessage[] => messages.filter((message, index) => messages.findIndex(other => other.id === message.id) === index);
const unavailable = (message: string): RelayOutcome<never> => ({ status: 'unavailable', message });

export const boardTransport = (clientOf: (identity: RelayIdentity) => Promise<Client>) => ({
  /** Idempotent: Relay dedupes on idempotencyKey = message.id (an identical retry returns the original), so a post never doubles. Returns the Relay message id, or the board id when Relay reports the key already used. */
  postBoard: async (identity: RelayIdentity, message: BoardMessage): Promise<RelayOutcome<string>> => {
    const valid = parseBoardMessage(message);
    if (!valid) return unavailable('Board message is malformed and was not posted.');
    return attemptRelay(async () => {
      const client = await clientOf(identity);
      try {
        return (await client.sendMessage({
          to: `#${identity.channel}`, text: valid.summary, idempotencyKey: valid.id,
          metadata: { kind: boardMetadataKind, message: valid },
        })).messageId;
      } catch (error) {
        // Relay answers 409 when the key was used with a different payload: the id is already on the board, and posting it again can never succeed.
        if (isAlreadyPosted(error)) return valid.id;
        throw error;
      }
    }, 'Agent Relay board is unavailable. Post again on the next check.');
  },
  /** Bounded: only messages past the actor's persisted cursor, oldest first. An unavailable read leaves the cursor untouched. */
  readBoard: (identity: RelayIdentity, cursor: RelayCursor): Promise<RelayOutcome<BoardRead>> => attemptRelay(async () => {
    const client = await clientOf(identity);
    const poll = await pollSince(request => client.messages.list(identity.channel, request), cursor, boardFrom, undefined, undefined, parseBoardMessage);
    return { messages: distinctById(poll.items), cursor: poll.cursor };
  }, 'Agent Relay board is unavailable. Reading will retry without changing state.'),
  readChannel: (identity: RelayIdentity, cursor: RelayCursor): Promise<RelayOutcome<ChannelRead>> => attemptRelay(async () => {
    const client = await clientOf(identity);
    const poll = await pollSince(request => client.messages.list(identity.channel, request), cursor, itemFrom, undefined, undefined, reviveItem);
    return {
      board: distinctById(poll.items.flatMap(item => 'board' in item ? [item.board] : [])),
      disruptions: poll.items.flatMap(item => 'disruption' in item ? [item.disruption] : []),
      cursor: poll.cursor,
    };
  }, 'Agent Relay channel is unavailable. Reading will retry without changing state.'),
});

export const { postBoard, readBoard, readChannel } = boardTransport(participant);
