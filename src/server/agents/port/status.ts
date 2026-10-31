import type { BoardMessage, PortBulletin, PortStatus } from '../../../core/board';
import type { PortId } from '../../../core/ports';
import type { Shipment } from '../../../core/types';

/** Upcoming calls only: the origin has departed, the same rule the assessor and the deterministic model use. */
export const relevance = (shipments: readonly Shipment[], portId: PortId): number =>
  shipments.filter(shipment => shipment.destination === portId || shipment.via.includes(portId)).length;

export const latestBulletin = (board: readonly BoardMessage[], portId: PortId): PortBulletin | null =>
  board.reduce<PortBulletin | null>((latest, message) =>
    message.kind === 'port.bulletin' && message.portId === portId && (latest === null || message.at >= latest.at) ? message : latest, null);

/** A port with no bulletin has said nothing, which is normal by construction: bulletins are posted on every change. */
export const portStatuses = (ports: readonly Readonly<{ id: PortId }>[], shipments: readonly Shipment[], board: readonly BoardMessage[]): readonly PortStatus[] =>
  ports.map(port => {
    const bulletin = latestBulletin(board, port.id);
    return { portId: port.id, risk: bulletin?.risk ?? 'normal', relevance: relevance(shipments, port.id), bulletin };
  });
