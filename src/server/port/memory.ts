import type { BoardMessage, EtaNotice, PortBulletin, ShipObservation } from '../../board';
import type { PortId } from '../../shared';
import type { RelayCursor } from '../board/transport';
import { latestBy, type Previous } from './risk';

/**
 * What a port agent remembers of the board between alarms. Bounded by the fleet, not by time: only each ship's latest observation
 * (an observation that moves a ship away must stay to supersede the one before it) and latest ETA for this port are kept.
 */
export type PortMemory = Readonly<{
  cursor: RelayCursor; observations: readonly ShipObservation[]; etas: readonly EtaNotice[];
  bulletin: PortBulletin | null; previous: Previous | null;
}>;

export const emptyMemory: PortMemory = { cursor: null, observations: [], etas: [], bulletin: null, previous: null };

export const absorb = (memory: PortMemory, messages: readonly BoardMessage[], portId: PortId): PortMemory => ({
  ...memory,
  observations: latestBy([...memory.observations, ...messages.filter((message): message is ShipObservation => message.kind === 'ship.observation')], item => item.shipmentId, item => item.observedAt),
  etas: latestBy([...memory.etas, ...messages.filter((message): message is EtaNotice => message.kind === 'ship.eta' && message.portId === portId)], item => item.shipmentId, item => item.at),
  bulletin: messages.reduce<PortBulletin | null>((latest, message) =>
    message.kind === 'port.bulletin' && message.portId === portId && (latest === null || message.at >= latest.at) ? message : latest, memory.bulletin),
});
