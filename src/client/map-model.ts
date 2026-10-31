import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { BoardMessage, PortBulletin, PortRisk, TrafficReport } from '../core/board';
import type { PortId } from '../core/ports';
import type { Dashboard, Shipment } from '../core/types';
import { positionAlong, progressAt, splitAt, unwrap, voyageRoute, type LngLat, type Route } from '../core/routes';

export type VesselView = Readonly<{
  id: string; vessel: string; risk: Shipment['risk']; delayHours: number; position: LngLat; progress: number; route: Route; laneSource: 'sea-lane' | 'supplied';
}>;

const departure = (shipment: Shipment): string | undefined => shipment.milestones[0]?.at;

export const vesselView = (shipment: Shipment, now: number): VesselView => {
  const lane = voyageRoute(shipment);
  const route = lane ?? unwrap(shipment.route);
  const departed = departure(shipment);
  const at = shipment.voyage?.status === 'stopped' ? Date.parse(shipment.voyage.statusSince) : now;
  const progress = shipment.voyage?.status === 'planned' ? 0 : shipment.voyage?.status === 'arrived' ? 1 : departed === undefined ? 0 : progressAt(departed, shipment.eta, at);
  return {
    id: shipment.id, vessel: shipment.vessel, risk: shipment.risk, delayHours: shipment.delayHours, route, progress,
    laneSource: lane ? 'sea-lane' : 'supplied',
    position: (departed === undefined ? undefined : positionAlong(route, progress)) ?? shipment.coordinates,
  };
};

export const vesselViews = (shipments: readonly Shipment[], now: number): readonly VesselView[] => shipments.map(shipment => vesselView(shipment, now));

type PortProperties = Readonly<{ id: PortId; name: string; label: string; risk: PortRisk | 'unreported'; relevance: number | null; anchored: number | null }>;
type PortPoint = Point & { coordinates: [number, number] };
const portRiskText: Readonly<Record<PortRisk, string>> = { normal: 'Normal', elevated: 'Elevated', severe: 'Severe' };

/** The catalog owns positions; reported status owns risk/relevance. Absence is never a normal assessment. */
export const portFeatures = (ports: Dashboard['ports'], statuses?: Dashboard['portStatus'], board: readonly BoardMessage[] = []): FeatureCollection<PortPoint, PortProperties> => ({
  type: 'FeatureCollection',
  features: ports.map((port): Feature<PortPoint, PortProperties> => {
    const status = statuses?.find(value => value.portId === port.id);
    const traffic = board.reduce<TrafficReport | null>((latest, message) => message.kind === 'city.traffic' && message.author.city === port.id && (!latest || message.at >= latest.at) ? message : latest, null);
    const bulletin = board.reduce<PortBulletin | null>((latest, message) => message.kind === 'port.bulletin' && message.portId === port.id && (!latest || message.at >= latest.at) ? message : latest, status?.bulletin ?? null);
    const risk = status?.risk ?? traffic?.risk ?? bulletin?.risk ?? 'unreported';
    const anchored = traffic?.anchored ?? bulletin?.anchored ?? null;
    const properties: PortProperties = {
      id: port.id, name: port.name, risk, relevance: status?.relevance ?? null, anchored,
      label: `${port.name}\n${risk === 'unreported' ? 'Risk unreported' : portRiskText[risk]}${status ? ` · ${status.relevance} upcoming ${status.relevance === 1 ? 'ship' : 'ships'}` : ''}${anchored === null ? '' : ` · ${anchored} anchored`}`,
    };
    return { type: 'Feature', id: port.id, properties, geometry: { type: 'Point', coordinates: [...port.coordinates] } };
  }),
});

const line = (id: string, coordinates: Route, risk?: Shipment['risk']): Feature<LineString> => ({ type: 'Feature', properties: { id, ...(risk === undefined ? {} : { risk }) }, geometry: { type: 'LineString', coordinates: coordinates.map(point => [...point]) } });
const collection = (features: readonly Feature<LineString>[]): FeatureCollection<LineString> => ({ type: 'FeatureCollection', features: [...features] });

export type RouteLayers = Readonly<{ voyages: FeatureCollection<LineString>; lanes: FeatureCollection<LineString>; sailed: FeatureCollection<LineString>; ahead: FeatureCollection<LineString> }>;

/** Every other ship shows the voyage still ahead of it, tagged with its risk; the selected voyage is split at the ship into its sailed and remaining legs. */
export const routeLayers = (views: readonly VesselView[], selectedId: string | undefined): RouteLayers => {
  const selected = views.find(view => view.id === selectedId);
  const split = selected && splitAt(selected.route, selected.progress);
  return {
    voyages: collection(views.filter(view => view.id !== selectedId && view.route.length > 1).map(view => line(view.id, view.route, view.risk))),
    lanes: collection(views.flatMap(view => {
      const ahead = view.id === selectedId ? [] : splitAt(view.route, view.progress).ahead;
      return ahead.length > 1 ? [line(view.id, ahead, view.risk)] : [];
    })),
    sailed: collection(selected && split ? [line(selected.id, split.sailed, selected.risk)] : []),
    ahead: collection(selected && split ? [line(selected.id, split.ahead, selected.risk)] : []),
  };
};

/** The cities a voyage of the fleet touches: origin, calls, destination. */
export const fleetPorts = <G extends Point, P extends Readonly<{ id: PortId }>>(features: FeatureCollection<G, P>, shipments: readonly Shipment[]): FeatureCollection<G, P> => {
  const touched = new Set(shipments.flatMap(shipment => [shipment.origin, ...shipment.via, shipment.destination]));
  return { ...features, features: features.features.filter(feature => touched.has(feature.properties.id)) };
};

const riskWord: Readonly<Record<Shipment['risk'], string>> = { delayed: 'Delayed', watch: 'Watch', 'on-track': 'On track' };

export const statusLine = (shipment: Pick<Shipment, 'risk' | 'delayHours'>): string =>
  shipment.risk !== 'on-track' && shipment.delayHours > 0 ? `${riskWord[shipment.risk]} · +${shipment.delayHours} h` : riskWord[shipment.risk];

export type Region = Readonly<{ id: string; label: string; bounds: Bounds }>;
export const regions: readonly Region[] = [
  { id: 'world', label: 'Whole world', bounds: [-180, -56, 180, 76] },
  { id: 'europe', label: 'Europe', bounds: [-25, 34, 45, 66] },
  { id: 'asia', label: 'Asia', bounds: [60, -12, 150, 50] },
  { id: 'americas', label: 'Americas', bounds: [-130, -56, -30, 60] },
];

export type Bounds = readonly [west: number, south: number, east: number, north: number];

export const boundsOf = (route: Route): Bounds | undefined => {
  if (route.length === 0) return undefined;
  const lons = route.map(point => point[0]);
  const lats = route.map(point => point[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
};


const TILE = 512;
const mercatorY = (lat: number): number => (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2;
const latitudeOf = (y: number): number => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;

type Camera = Readonly<{ center: LngLat; zoom: number }>;

/** The largest web-mercator zoom at which the bounds fit the viewport inside the padding, centred on them. */
export const cameraFor = (bounds: Bounds, width: number, height: number, padding: number): Camera => {
  const [west, south, east, north] = bounds;
  const top = mercatorY(north);
  const bottom = mercatorY(south);
  const across = Math.max((east - west) / 360, 1e-9) * TILE;
  const down = Math.max(bottom - top, 1e-9) * TILE;
  const zoom = Math.log2(Math.max(Math.min((width - 2 * padding) / across, (height - 2 * padding) / down), 1e-9));
  return { center: [(west + east) / 2, latitudeOf((top + bottom) / 2)], zoom };
};

/** The zoom at which the globe's disc spans the viewport's shorter side inside the padding. */
export const globeZoom = (width: number, height: number, padding: number): number => Math.log2(Math.max((Math.min(width, height) - 2 * padding) * Math.PI / TILE, 1e-9));
