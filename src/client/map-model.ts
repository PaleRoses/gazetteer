import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { BoardMessage, PortBulletin, PortRisk, TrafficReport } from '../core/board';
import type { PortId } from '../core/ports';
import type { Dashboard, Shipment } from '../core/types';
import { positionAlong, progressAt, splitAt, unwrap, voyageRoute, type LngLat, type Route } from '../core/routes';

export type VesselView = Readonly<{
  id: string; vessel: string; risk: Shipment['risk']; position: LngLat; progress: number; route: Route; laneSource: 'sea-lane' | 'supplied';
}>;

const departure = (shipment: Shipment): string | undefined => shipment.milestones[0]?.at;

export const vesselView = (shipment: Shipment, now: number): VesselView => {
  const lane = voyageRoute(shipment);
  const route = lane ?? unwrap(shipment.route);
  const departed = departure(shipment);
  const progress = departed === undefined ? 0 : progressAt(departed, shipment.eta, now);
  return {
    id: shipment.id, vessel: shipment.vessel, risk: shipment.risk, route, progress,
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

export type RouteLayers = Readonly<{ lanes: FeatureCollection<LineString>; sailed: FeatureCollection<LineString>; ahead: FeatureCollection<LineString> }>;

/** Every voyage remains visible; the selected voyage additionally gets a sailed/ahead overlay. */
export const routeLayers = (views: readonly VesselView[], selectedId: string | undefined): RouteLayers => {
  const selected = views.find(view => view.id === selectedId);
  const split = selected && splitAt(selected.route, selected.progress);
  return {
    lanes: collection(views.map(view => line(view.id, view.route, view.risk))),
    sailed: collection(selected && split ? [line(selected.id, split.sailed, selected.risk)] : []),
    ahead: collection(selected && split ? [line(selected.id, split.ahead, selected.risk)] : []),
  };
};

export type Bounds = readonly [west: number, south: number, east: number, north: number];

export const boundsOf = (route: Route): Bounds | undefined => {
  if (route.length === 0) return undefined;
  const lons = route.map(point => point[0]);
  const lats = route.map(point => point[1]);
  return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)];
};

const range = (from: number, to: number, step: number): readonly number[] => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, index) => from + index * step);

export const graticule = (step: number): FeatureCollection<LineString> => collection([
  ...range(-180, 180, step).map(lon => line(`lon${lon}`, range(-80, 80, 10).map((lat): LngLat => [lon, lat]))),
  ...range(-60, 60, step).map(lat => line(`lat${lat}`, range(-180, 180, 10).map((lon): LngLat => [lon, lat]))),
]);
