import { shipMindFor } from './names.js';
import { portById, ports, type PortId } from './ports.js';
import { positionAlong, routeLengthKm, sharedLengthKm, voyageRoute } from './routes.js';
import type { Disruption, Shipment } from './types.js';

const afterHours = (at: string, hours: number): string => new Date(Date.parse(at) + hours * 3_600_000).toISOString();
const kmPerNauticalMile = 1.852;

/**
 * The demo fleet: real ports and real trade lanes, fictional vessels. A row places its vessel by the share of the voyage sailed
 * (`progress`), by the hours left to its ETA (`arrivalHours`), or by the hours since its Cape lane left its Suez plan (`divergedHoursAgo`).
 * Durations follow from the lane's length at the row's service speed, so every ETA is derived from geometry.
 */
type Place = Readonly<{ progress: number }> | Readonly<{ arrivalHours: number }> | Readonly<{ divergedHoursAgo: number }>;
type Voyage = Pick<Shipment, 'id' | 'vessel' | 'cargo' | 'containers' | 'origin' | 'destination'> & Readonly<{ knots: number; place: Place }>;

const voyages: readonly Voyage[] = [
  { id: 'gz-1046', vessel: 'Orient Harbour', cargo: 'Semiconductor equipment', containers: 28, origin: 'shanghai', destination: 'singapore', knots: 18, place: { arrivalHours: 0.2 } },
  { id: 'gz-1047', vessel: 'Cape Meridian', cargo: 'Packaged chemicals', containers: 16, origin: 'rotterdam', destination: 'singapore', knots: 17, place: { arrivalHours: 0.5 } },
  { id: 'gz-1048', vessel: 'Baltic Dawn', cargo: 'Furniture & homeware', containers: 22, origin: 'singapore', destination: 'rotterdam', knots: 17, place: { arrivalHours: 40 } },
  { id: 'gz-1049', vessel: 'North Sea Voyager', cargo: 'Apparel', containers: 30, origin: 'shanghai', destination: 'rotterdam', knots: 17, place: { arrivalHours: 30 } },
  { id: 'gz-1050', vessel: 'Nordic Pioneer', cargo: 'Almonds & dried fruit', containers: 40, origin: 'los-angeles', destination: 'rotterdam', knots: 16, place: { arrivalHours: 44 } },
  { id: 'gz-1051', vessel: 'Meridian Crest', cargo: 'Cold-chain pharmaceuticals', containers: 14, origin: 'rotterdam', destination: 'singapore', knots: 17, place: { arrivalHours: 120 } },
  { id: 'gz-1052', vessel: 'Pacific Dawn', cargo: 'Consumer appliances', containers: 26, origin: 'shanghai', destination: 'los-angeles', knots: 17, place: { progress: 0.5 } },
  { id: 'gz-1053', vessel: 'Jade Corridor', cargo: 'Household goods', containers: 26, origin: 'ningbo-zhoushan', destination: 'antwerp', knots: 17, place: { progress: 0.55 } },
  { id: 'gz-1054', vessel: 'Han River Spirit', cargo: 'Consumer electronics', containers: 20, origin: 'busan', destination: 'rotterdam', knots: 18, place: { progress: 0.35 } },
  { id: 'gz-1055', vessel: 'Strait Venturer', cargo: 'Natural rubber', containers: 18, origin: 'port-klang', destination: 'antwerp', knots: 17, place: { divergedHoursAgo: 1 } },
  { id: 'gz-1056', vessel: 'Aegean Lantern', cargo: 'Machinery parts', containers: 15, origin: 'singapore', destination: 'piraeus', knots: 18, place: { progress: 0.6 } },
  { id: 'gz-1057', vessel: 'Serendib Trader', cargo: 'Tea & spices', containers: 12, origin: 'colombo', destination: 'rotterdam', knots: 16, place: { divergedHoursAgo: 1 } },
  { id: 'gz-1058', vessel: 'Gulf Meridian', cargo: 'Polymer resins', containers: 24, origin: 'jebel-ali', destination: 'rotterdam', knots: 17, place: { divergedHoursAgo: 5.5 } },
  { id: 'gz-1059', vessel: 'Eastern Tide', cargo: 'Solar modules', containers: 30, origin: 'ningbo-zhoushan', destination: 'los-angeles', knots: 18, place: { progress: 0.7 } },
  { id: 'gz-1060', vessel: 'Morning Calm Voyager', cargo: 'Automotive parts', containers: 22, origin: 'busan', destination: 'los-angeles', knots: 18, place: { progress: 0.25 } },
  { id: 'gz-1061', vessel: 'Lion City Trader', cargo: 'Furniture', containers: 16, origin: 'singapore', destination: 'los-angeles', knots: 17, place: { progress: 0.4 } },
  { id: 'gz-1062', vessel: 'Atlantic Jade', cargo: 'Toys & games', containers: 28, origin: 'shanghai', destination: 'new-york-new-jersey', knots: 17, place: { progress: 0.6 } },
  { id: 'gz-1063', vessel: 'Savannah Sunrise', cargo: 'Home appliances', containers: 24, origin: 'ningbo-zhoushan', destination: 'savannah', knots: 17, place: { progress: 0.45 } },
  { id: 'gz-1064', vessel: 'Hallyeo Pioneer', cargo: 'Tyres', containers: 18, origin: 'busan', destination: 'savannah', knots: 17, place: { progress: 0.8 } },
  { id: 'gz-1065', vessel: 'Malacca Courier', cargo: 'Palm oil derivatives', containers: 10, origin: 'port-klang', destination: 'singapore', knots: 15, place: { arrivalHours: 0.9 } },
  { id: 'gz-1066', vessel: 'Serangoon Star', cargo: 'Electronic components', containers: 14, origin: 'singapore', destination: 'colombo', knots: 16, place: { progress: 0.5 } },
  { id: 'gz-1067', vessel: 'Dune Navigator', cargo: 'Aluminium ingots', containers: 20, origin: 'jebel-ali', destination: 'singapore', knots: 17, place: { arrivalHours: 1.4 } },
  { id: 'gz-1068', vessel: 'Huangpu Spirit', cargo: 'Industrial machinery', containers: 22, origin: 'singapore', destination: 'shanghai', knots: 17, place: { progress: 0.5 } },
  { id: 'gz-1069', vessel: 'Maas Navigator', cargo: 'Specialty chemicals', containers: 18, origin: 'rotterdam', destination: 'new-york-new-jersey', knots: 17, place: { progress: 0.5 } },
  { id: 'gz-1070', vessel: 'Hellenic Star', cargo: 'Marble & stone', containers: 12, origin: 'piraeus', destination: 'new-york-new-jersey', knots: 16, place: { progress: 0.6 } },
  { id: 'gz-1071', vessel: 'Paulista Grace', cargo: 'Coffee', containers: 30, origin: 'santos', destination: 'rotterdam', knots: 16, place: { progress: 0.5 } },
  { id: 'gz-1073', vessel: 'Haeundae Breeze', cargo: 'Electronic displays', containers: 20, origin: 'busan', destination: 'singapore', knots: 18, place: { arrivalHours: 2 } },
  { id: 'gz-1072', vessel: 'Liberty Southern', cargo: 'Agricultural machinery', containers: 14, origin: 'new-york-new-jersey', destination: 'santos', knots: 16, place: { progress: 0.7 } },
];


type Unnamed = Omit<Shipment, 'agent'>;

export function demoShipments(now: Date = new Date()): readonly Shipment[] {
  const at = now.toISOString();
  const voyage = (shipment: Pick<Shipment, 'id' | 'vessel' | 'reference' | 'cargo' | 'containers' | 'origin' | 'destination' | 'via' | 'coordinates' | 'route'>, arrivalHours: number, departedHoursAgo = 96): Unnamed => ({
    ...shipment, baselineEta: afterHours(at, arrivalHours), eta: afterHours(at, arrivalHours),
    risk: 'on-track', delayHours: 0, change: 'No change to the arrival estimate.', action: null,
    milestones: [
      { label: 'Departed origin', at: afterHours(at, -departedHoursAgo), status: 'complete' },
      { label: shipment.via.length ? 'Transshipment berth' : 'Ocean transit', at: afterHours(at, 24), status: 'current' },
      { label: 'Discharge at destination', at: afterHours(at, arrivalHours), status: 'upcoming' },
    ], evidence: [], appliedDisruptions: [],
  });
  /** A table row placed on its lane: the voyage takes the lane's length at the row's service speed, so the ETA follows from geometry. */
  const placed = (row: Voyage): Unnamed => {
    const route = voyageRoute({ ...row, via: [] }) ?? [];
    const kmPerHour = row.knots * kmPerNauticalMile;
    const durationHours = routeLengthKm(route) / kmPerHour;
    const sailedHours = 'progress' in row.place ? row.place.progress * durationHours
      : 'arrivalHours' in row.place ? durationHours - row.place.arrivalHours
      : sharedLengthKm(route, voyageRoute({ ...row, via: [] }, 'cape') ?? route) / kmPerHour + row.place.divergedHoursAgo;
    const coordinates = positionAlong(route, sailedHours / durationHours) ?? portById.get(row.origin)?.coordinates ?? [0, 0];
    return voyage({ id: row.id, vessel: row.vessel, reference: row.id.toUpperCase(), cargo: row.cargo, containers: row.containers, origin: row.origin, destination: row.destination, via: [], coordinates, route }, durationHours - sailedHours, sailedHours);
  };
  return [
    voyage({ id: 'gz-1042', vessel: 'Meridian Star', reference: 'GZ-1042', cargo: 'Consumer electronics', containers: 24, origin: 'shanghai', destination: 'rotterdam', via: ['singapore'], coordinates: [108, 9], route: [[121.5,31.2],[122,23],[113,15],[103.82,1.26],[80,5],[58,-12],[22,-36],[12,-28],[-12,7],[-15,32],[-5,48],[4.48,51.92]] }, 312),
    voyage({ id: 'gz-1043', vessel: 'Pacific Laurel', reference: 'GZ-1043', cargo: 'Automotive components', containers: 18, origin: 'shanghai', destination: 'los-angeles', via: [], coordinates: [165, 37], route: [[121.5,31.2],[140,35],[165,37],[180,38],[-165,38],[-140,35],[-118.26,33.74]] }, 216),
    voyage({ id: 'gz-1044', vessel: 'Atlas Venture', reference: 'GZ-1044', cargo: 'Industrial machinery', containers: 12, origin: 'rotterdam', destination: 'singapore', via: [], coordinates: [75, 3], route: [[4.48,51.92],[-5,48],[-15,32],[-12,7],[12,-28],[22,-36],[58,-12],[75,3],[103.82,1.26]] }, 120),
    voyage({ id: 'gz-1045', vessel: 'Northern Passage', reference: 'GZ-1045', cargo: 'Textiles & apparel', containers: 32, origin: 'los-angeles', destination: 'shanghai', via: [], coordinates: [-150, 32], route: [[-118.26,33.74],[-150,32],[-175,30],[180,30],[155,28],[130,25],[121.5,31.2]] }, 240),
    ...voyages.map(placed),
  ].map((shipment, index): Shipment => ({ ...shipment, agent: shipMindFor(index) }));
}

/** Synthetic exposure model: only upcoming calls can be affected; evidence IDs are idempotency keys. */
export function assessDisruption(shipment: Shipment, disruption: Disruption): Shipment {
  const added = disruption.delayHours;
  if (added === null || shipment.appliedDisruptions.includes(disruption.id)
    || !(shipment.destination === disruption.portId || shipment.via.includes(disruption.portId))) return shipment;
  const delayHours = shipment.delayHours + added;
  const eta = afterHours(shipment.baselineEta, delayHours);
  const port = portById.get(disruption.portId);
  return {
    ...shipment, eta, delayHours, risk: delayHours >= 24 ? 'delayed' : 'watch',
    change: `${port?.name ?? disruption.portId} disruption adds ${added}h to the arrival estimate.`,
    action: 'Confirm the revised delivery window with your consignee.',
    milestones: shipment.milestones.map(milestone => milestone.status === 'complete' ? milestone : { ...milestone, at: afterHours(milestone.at, added) }),
    evidence: [...shipment.evidence, disruption.evidence],
    appliedDisruptions: [...shipment.appliedDisruptions, disruption.id],
  };
}

/** The ports a fleet still calls at (destination or via; origins are behind it): only these run a port actor. Registry order. */
export const activePorts = (fleet: readonly Shipment[]) =>
  ports.filter(port => fleet.some(shipment => shipment.destination === port.id || shipment.via.includes(port.id)));
