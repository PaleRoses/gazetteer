import type { Disruption, Port, Shipment } from './shared';

export const ports: readonly Port[] = [
  { id: 'singapore', name: 'Singapore', country: 'Singapore', coordinates: [103.82, 1.26] },
  { id: 'rotterdam', name: 'Rotterdam', country: 'Netherlands', coordinates: [4.48, 51.92] },
  { id: 'shanghai', name: 'Shanghai', country: 'China', coordinates: [121.5, 31.2] },
  { id: 'los-angeles', name: 'Los Angeles', country: 'United States', coordinates: [-118.26, 33.74] },
];

const afterHours = (at: string, hours: number): string => new Date(Date.parse(at) + hours * 3_600_000).toISOString();

export function demoShipments(now: Date = new Date()): readonly Shipment[] {
  const at = now.toISOString();
  const voyage = (shipment: Pick<Shipment, 'id' | 'vessel' | 'reference' | 'cargo' | 'containers' | 'origin' | 'destination' | 'via' | 'coordinates' | 'route'>, arrivalHours: number): Shipment => ({
    ...shipment, baselineEta: afterHours(at, arrivalHours), eta: afterHours(at, arrivalHours),
    risk: 'on-track', delayHours: 0, change: 'No change to the arrival estimate.', action: null,
    milestones: [
      { label: 'Departed origin', at: afterHours(at, -96), status: 'complete' },
      { label: shipment.via.length ? 'Transshipment berth' : 'Ocean transit', at: afterHours(at, 24), status: 'current' },
      { label: 'Discharge at destination', at: afterHours(at, arrivalHours), status: 'upcoming' },
    ], evidence: [], appliedDisruptions: [],
  });
  return [
    voyage({ id: 'gz-1042', vessel: 'Meridian Star', reference: 'GZ-1042', cargo: 'Consumer electronics', containers: 24, origin: 'shanghai', destination: 'rotterdam', via: ['singapore'], coordinates: [108, 9], route: [[121.5,31.2],[122,23],[113,15],[103.82,1.26],[80,5],[58,-12],[22,-36],[12,-28],[-12,7],[-15,32],[-5,48],[4.48,51.92]] }, 312),
    voyage({ id: 'gz-1043', vessel: 'Pacific Laurel', reference: 'GZ-1043', cargo: 'Automotive components', containers: 18, origin: 'shanghai', destination: 'los-angeles', via: [], coordinates: [165, 37], route: [[121.5,31.2],[140,35],[165,37],[180,38],[-165,38],[-140,35],[-118.26,33.74]] }, 216),
    voyage({ id: 'gz-1044', vessel: 'Atlas Venture', reference: 'GZ-1044', cargo: 'Industrial machinery', containers: 12, origin: 'rotterdam', destination: 'singapore', via: [], coordinates: [75, 3], route: [[4.48,51.92],[-5,48],[-15,32],[-12,7],[12,-28],[22,-36],[58,-12],[75,3],[103.82,1.26]] }, 120),
    voyage({ id: 'gz-1045', vessel: 'Northern Passage', reference: 'GZ-1045', cargo: 'Textiles & apparel', containers: 32, origin: 'los-angeles', destination: 'shanghai', via: [], coordinates: [-150, 32], route: [[-118.26,33.74],[-150,32],[-175,30],[180,30],[155,28],[130,25],[121.5,31.2]] }, 240),
  ];
}

/** Synthetic exposure model: only upcoming calls can be affected; evidence IDs are idempotency keys. */
export function assessDisruption(shipment: Shipment, disruption: Disruption): Shipment {
  if (shipment.appliedDisruptions.includes(disruption.id)
    || !(shipment.destination === disruption.portId || shipment.via.includes(disruption.portId))) return shipment;
  const delayHours = shipment.delayHours + disruption.delayHours;
  const eta = afterHours(shipment.baselineEta, delayHours);
  const port = ports.find(value => value.id === disruption.portId);
  return {
    ...shipment, eta, delayHours, risk: delayHours >= 24 ? 'delayed' : 'watch',
    change: `${port?.name ?? disruption.portId} disruption adds ${disruption.delayHours}h to the arrival estimate.`,
    action: 'Confirm the revised delivery window with your consignee.',
    milestones: shipment.milestones.map(milestone => milestone.status === 'complete' ? milestone : { ...milestone, at: afterHours(milestone.at, disruption.delayHours) }),
    evidence: [...shipment.evidence, disruption.evidence],
    appliedDisruptions: [...shipment.appliedDisruptions, disruption.id],
  };
}
