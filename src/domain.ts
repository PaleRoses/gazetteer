import { positionAlong, progressAt, voyageRoute } from './sea-routes.js';
import type { Disruption, Port, PortId, Shipment } from './shared';

export const ports: readonly Port[] = [
  { id: 'singapore', name: 'Singapore', country: 'Singapore', coordinates: [103.82, 1.26] },
  { id: 'rotterdam', name: 'Rotterdam', country: 'Netherlands', coordinates: [4.48, 51.92] },
  { id: 'shanghai', name: 'Shanghai', country: 'China', coordinates: [121.5, 31.2] },
  { id: 'los-angeles', name: 'Los Angeles', country: 'United States', coordinates: [-118.26, 33.74] },
  { id: 'jebel-ali', name: 'Jebel Ali', country: 'United Arab Emirates', coordinates: [55.06, 24.99] },
];

const afterHours = (at: string, hours: number): string => new Date(Date.parse(at) + hours * 3_600_000).toISOString();

export function demoShipments(now: Date = new Date()): readonly Shipment[] {
  const at = now.toISOString();
  const voyage = (shipment: Pick<Shipment, 'id' | 'vessel' | 'reference' | 'cargo' | 'containers' | 'origin' | 'destination' | 'via' | 'coordinates' | 'route'>, arrivalHours: number, departedHoursAgo = 96): Shipment => ({
    ...shipment, baselineEta: afterHours(at, arrivalHours), eta: afterHours(at, arrivalHours),
    risk: 'on-track', delayHours: 0, change: 'No change to the arrival estimate.', action: null,
    milestones: [
      { label: 'Departed origin', at: afterHours(at, -departedHoursAgo), status: 'complete' },
      { label: shipment.via.length ? 'Transshipment berth' : 'Ocean transit', at: afterHours(at, 24), status: 'current' },
      { label: 'Discharge at destination', at: afterHours(at, arrivalHours), status: 'upcoming' },
    ], evidence: [], appliedDisruptions: [],
  });
  type Spec = Pick<Shipment, 'id' | 'vessel' | 'reference' | 'cargo' | 'containers'> & Readonly<{ origin: PortId; destination: PortId }>;
  /** A sea-lane voyage that departed `departedHoursAgo` hours ago, placed where its ETA says it is. */
  const lane = (spec: Spec, arrivalHours: number, departedHoursAgo: number): Shipment => {
    const route = voyageRoute({ ...spec, via: [] }) ?? [];
    const departed = Date.parse(at) - departedHoursAgo * 3_600_000;
    const coordinates = positionAlong(route, progressAt(new Date(departed).toISOString(), afterHours(at, arrivalHours), Date.parse(at))) ?? ports.find(port => port.id === spec.origin)?.coordinates ?? [0, 0];
    return voyage({ ...spec, via: [], coordinates, route }, arrivalHours, departedHoursAgo);
  };
  return [
    voyage({ id: 'gz-1042', vessel: 'Meridian Star', reference: 'GZ-1042', cargo: 'Consumer electronics', containers: 24, origin: 'shanghai', destination: 'rotterdam', via: ['singapore'], coordinates: [108, 9], route: [[121.5,31.2],[122,23],[113,15],[103.82,1.26],[80,5],[58,-12],[22,-36],[12,-28],[-12,7],[-15,32],[-5,48],[4.48,51.92]] }, 312),
    voyage({ id: 'gz-1043', vessel: 'Pacific Laurel', reference: 'GZ-1043', cargo: 'Automotive components', containers: 18, origin: 'shanghai', destination: 'los-angeles', via: [], coordinates: [165, 37], route: [[121.5,31.2],[140,35],[165,37],[180,38],[-165,38],[-140,35],[-118.26,33.74]] }, 216),
    voyage({ id: 'gz-1044', vessel: 'Atlas Venture', reference: 'GZ-1044', cargo: 'Industrial machinery', containers: 12, origin: 'rotterdam', destination: 'singapore', via: [], coordinates: [75, 3], route: [[4.48,51.92],[-5,48],[-15,32],[-12,7],[12,-28],[22,-36],[58,-12],[75,3],[103.82,1.26]] }, 120),
    voyage({ id: 'gz-1045', vessel: 'Northern Passage', reference: 'GZ-1045', cargo: 'Textiles & apparel', containers: 32, origin: 'los-angeles', destination: 'shanghai', via: [], coordinates: [-150, 32], route: [[-118.26,33.74],[-150,32],[-175,30],[180,30],[155,28],[130,25],[121.5,31.2]] }, 240),
    lane({ id: 'gz-1046', vessel: 'Orient Harbour', reference: 'GZ-1046', cargo: 'Semiconductor equipment', containers: 28, origin: 'shanghai', destination: 'singapore' }, 30, 130),
    lane({ id: 'gz-1047', vessel: 'Cape Meridian', reference: 'GZ-1047', cargo: 'Packaged chemicals', containers: 16, origin: 'rotterdam', destination: 'singapore' }, 40, 470),
    lane({ id: 'gz-1048', vessel: 'Baltic Dawn', reference: 'GZ-1048', cargo: 'Furniture & homeware', containers: 22, origin: 'singapore', destination: 'rotterdam' }, 40, 480),
    lane({ id: 'gz-1049', vessel: 'North Sea Voyager', reference: 'GZ-1049', cargo: 'Apparel', containers: 30, origin: 'shanghai', destination: 'rotterdam' }, 30, 600),
    lane({ id: 'gz-1050', vessel: 'Nordic Pioneer', reference: 'GZ-1050', cargo: 'Almonds & dried fruit', containers: 40, origin: 'los-angeles', destination: 'rotterdam' }, 44, 460),
    lane({ id: 'gz-1051', vessel: 'Meridian Crest', reference: 'GZ-1051', cargo: 'Cold-chain pharmaceuticals', containers: 14, origin: 'rotterdam', destination: 'singapore' }, 120, 400),
    lane({ id: 'gz-1052', vessel: 'Pacific Dawn', reference: 'GZ-1052', cargo: 'Consumer appliances', containers: 26, origin: 'shanghai', destination: 'los-angeles' }, 230, 250),
    lane({ id: 'gz-1053', vessel: 'Gulf Horizon', reference: 'GZ-1053', cargo: 'Aluminium & industrial components', containers: 20, origin: 'jebel-ali', destination: 'singapore' }, 192, 2),
  ];
}

/** Synthetic exposure model: only upcoming calls can be affected; evidence IDs are idempotency keys. */
export function assessDisruption(shipment: Shipment, disruption: Disruption): Shipment {
  const added = disruption.delayHours;
  if (added === null || shipment.appliedDisruptions.includes(disruption.id)
    || !(shipment.destination === disruption.portId || shipment.via.includes(disruption.portId))) return shipment;
  const delayHours = shipment.delayHours + added;
  const eta = afterHours(shipment.baselineEta, delayHours);
  const port = ports.find(value => value.id === disruption.portId);
  return {
    ...shipment, eta, delayHours, risk: delayHours >= 24 ? 'delayed' : 'watch',
    change: `${port?.name ?? disruption.portId} disruption adds ${added}h to the arrival estimate.`,
    action: 'Confirm the revised delivery window with your consignee.',
    milestones: shipment.milestones.map(milestone => milestone.status === 'complete' ? milestone : { ...milestone, at: afterHours(milestone.at, added) }),
    evidence: [...shipment.evidence, disruption.evidence],
    appliedDisruptions: [...shipment.appliedDisruptions, disruption.id],
  };
}
