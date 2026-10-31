import type { Shipment } from './types.js';
import type { PortId } from './ports.js';

const viaMilestone = (shipment: Shipment) => shipment.milestones.find(milestone => milestone.label === 'Transshipment berth');

/** Ports still ahead, each with this ship's ETA there: via ports read their transshipment milestone, the destination the shipment ETA. */
export function remainingCalls(shipment: Shipment): readonly Readonly<{ portId: PortId; eta: string }>[] {
  const via = viaMilestone(shipment);
  return [
    ...(via && via.status !== 'complete' ? shipment.via.map(portId => ({ portId, eta: via.at })) : []),
    { portId: shipment.destination, eta: shipment.eta },
  ];
}
