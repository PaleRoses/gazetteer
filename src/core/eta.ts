import type { Shipment } from './types.js';

const afterHours = (at: string, hours: number): string => new Date(Date.parse(at) + hours * 3_600_000).toISOString();

/** The one place an arrival estimate moves: every milestone not yet complete shifts by exactly `deltaHours`, and the ETA is the baseline plus the total delay. */
export const shiftEta = <S extends Shipment>(shipment: S, deltaHours: number): S => {
  if (deltaHours === 0) return shipment;
  const delayHours = shipment.delayHours + deltaHours;
  return {
    ...shipment, delayHours, eta: afterHours(shipment.baselineEta, delayHours),
    milestones: shipment.milestones.map(milestone => milestone.status === 'complete' ? milestone : { ...milestone, at: afterHours(milestone.at, deltaHours) }),
  };
};
