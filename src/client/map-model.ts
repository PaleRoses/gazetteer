import type { Feature, FeatureCollection, LineString } from 'geojson';
import type { Shipment } from '../shared';
import { positionAlong, progressAt, splitAt, unwrap, voyageRoute, type LngLat, type Route } from '../sea-routes';

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

const line = (id: string, coordinates: Route): Feature<LineString> => ({ type: 'Feature', properties: { id }, geometry: { type: 'LineString', coordinates: coordinates.map(point => [...point]) } });
const collection = (features: readonly Feature<LineString>[]): FeatureCollection<LineString> => ({ type: 'FeatureCollection', features: [...features] });

export type RouteLayers = Readonly<{ lanes: FeatureCollection<LineString>; sailed: FeatureCollection<LineString>; ahead: FeatureCollection<LineString> }>;

/** Faint lanes for every voyage; the selected voyage split into the part sailed and the part ahead. */
export const routeLayers = (views: readonly VesselView[], selectedId: string | undefined): RouteLayers => {
  const selected = views.find(view => view.id === selectedId);
  const split = selected && splitAt(selected.route, selected.progress);
  return {
    lanes: collection(views.filter(view => view.id !== selectedId).map(view => line(view.id, view.route))),
    sailed: collection(selected && split ? [line(selected.id, split.sailed)] : []),
    ahead: collection(selected && split ? [line(selected.id, split.ahead)] : []),
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
