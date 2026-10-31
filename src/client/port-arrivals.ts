import { remainingCalls } from '../core/port-calls';
import type { PortId } from '../core/ports';
import type { Shipment } from '../core/types';

/** A past estimate is overdue, not evidence of arrival. Only reported/completed arrivals leave the list. */
export const incomingShips = (shipments: readonly Shipment[], portId: PortId) => shipments.flatMap(ship => {
  if (ship.voyage?.status === 'arrived' || ship.milestones.some(m => /discharge|arrival at destination/i.test(m.label) && m.status === 'complete')) return [];
  const call = remainingCalls(ship).find(call => call.portId === portId);
  return call ? [{ ship, eta: call.eta, transit: ship.destination !== portId }] : [];
}).sort((a, b) => Date.parse(a.eta) - Date.parse(b.eta));

export const arrivalStatus = (ship: Shipment): string => ({ planned: 'Planned', underway: 'Underway', stopped: 'Stopped', arrived: 'Arrived' })[ship.voyage?.status ?? 'underway'];
