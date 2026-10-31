import type { BoardMessage } from '../../board';
import { relaySuccess, type PortId, type RelayOutcome } from '../../shared';
import type { BoardRead, RelayCursor } from '../board/transport';
import type { RelayIdentity } from '../relay';
import type { PortNotice } from '../sources';
import type { LonLat } from '../sources/notice';
import { decideBulletin } from './bulletin';
import { absorb, type PortMemory } from './memory';
import { assessPort } from './risk';

export type BoardIo = Readonly<{
  read: (identity: RelayIdentity, cursor: RelayCursor) => Promise<RelayOutcome<BoardRead>>;
  post: (identity: RelayIdentity, message: BoardMessage) => Promise<RelayOutcome<string>>;
}>;

export type Watch = Readonly<{ portId: PortId; name: string; coordinates: LonLat; now: Date; notices: readonly PortNotice[] }>;

/**
 * One alarm's worth of a port's own watching: read what peers posted since the cursor, assess, and post a bulletin only if
 * something changed. Failures are data: an unreadable board leaves the memory untouched; a failed post keeps the old bulletin, so the
 * next alarm derives the same id and Relay dedupes it.
 */
export async function watchPort(io: BoardIo, identity: RelayIdentity, memory: PortMemory, watch: Watch): Promise<Readonly<{ memory: PortMemory; outcome: RelayOutcome<null> }>> {
  const read = await io.read(identity, memory.cursor);
  if (read.status === 'unavailable') return { memory, outcome: read };
  const absorbed = { ...absorb(memory, read.value.messages, watch.portId), cursor: read.value.cursor };
  const assessed = assessPort({ portId: watch.portId, coordinates: watch.coordinates, now: watch.now, notices: watch.notices, observations: absorbed.observations, etas: absorbed.etas, previous: absorbed.previous });
  const advanced: PortMemory = { ...absorbed, previous: { levels: assessed.levels, anchoredShips: assessed.anchoredShips } };
  const bulletin = decideBulletin(assessed, absorbed.bulletin, watch.name, watch.now);
  if (bulletin === null) return { memory: advanced, outcome: relaySuccess(null) };
  const posted = await io.post(identity, bulletin);
  return posted.status === 'unavailable' ? { memory: advanced, outcome: posted } : { memory: { ...advanced, bulletin }, outcome: relaySuccess(null) };
}
