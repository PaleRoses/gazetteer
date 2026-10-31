import { createEffect, createMemo, createSignal, Index, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Menu } from '@ark-ui/solid';
import { ChevronDown } from 'lucide-solid';
import type { GeoJSONSource, Map as MapLibreMap, Marker, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Dashboard, Shipment } from '../core/types';
import type { LngLat } from '../core/routes';
import { boundsOf, cameraFor, fleetPorts, globeZoom, portFeatures, regions, routeLayers, statusLine, vesselViews, type Bounds, type Region } from './map-model';
import { PixelShip, RiskMark } from './sprites';
import './styles/map.css';

type MapLibre = typeof import('maplibre-gl');
type Runtime = Readonly<{ lib: MapLibre; map: MapLibreMap }>;
type Selection = Readonly<{ dashboard: Dashboard | null; selected: Shipment | undefined; focusId: string | null; onSelect: (id: string) => void }>;
type Projection = 'mercator' | 'globe';
const COLOURS = { ocean: '#0b0b0b', land: '#2a2a2a', coast: '#3a3a3a', route: '#5fe3c0' } as const;
const FRAME_PADDING = { top: 90, bottom: 75, left: 70, right: 70 } as const;
const WORLD = regions[0];
const style = (origin: string): StyleSpecification => ({
  version: 8, projection: { type: 'mercator' },
  sources: { land: { type: 'geojson', data: `${origin}/geo/land.geojson` } },
  layers: [
    { id: 'ocean', type: 'background', paint: { 'background-color': COLOURS.ocean } },
    { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': COLOURS.land } },
    { id: 'coast', type: 'line', source: 'land', paint: { 'line-color': COLOURS.coast, 'line-width': 0.8 } },
    { id: 'sailed', type: 'line', source: 'sailed', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOURS.route, 'line-width': 2, 'line-dasharray': [0.1, 2.6], 'line-opacity': 0.45 } },
    { id: 'ahead', type: 'line', source: 'ahead', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOURS.route, 'line-width': 2.4, 'line-dasharray': [0.1, 2.4], 'line-opacity': 0.95 } },
  ],
});

function MapMarker(props: Readonly<{ runtime: Runtime; position: LngLat; children: JSX.Element }>) {
  let element: HTMLDivElement | undefined;
  const [marker, setMarker] = createSignal<Marker>();
  onMount(() => {
    if (!element) return;
    const value = new props.runtime.lib.Marker({ element, anchor: 'center' }).setLngLat([...props.position]).addTo(props.runtime.map);
    setMarker(value);
    onCleanup(() => value.remove());
  });
  createEffect(() => { marker()?.setLngLat([...props.position]); });
  return <div ref={element} class="map-marker">{props.children}</div>;
}
const setFeatures = (map: MapLibreMap, id: string, data: GeoJSON.FeatureCollection): void => { (map.getSource(id) as GeoJSONSource | undefined)?.setData(data); };
const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const lngLatBounds = (bounds: Bounds): [[number, number], [number, number]] => [[bounds[0], bounds[1]], [bounds[2], bounds[3]]];

export function ShipmentMap(props: Selection) {
  let container: HTMLDivElement | undefined;
  const [ready, setReady] = createSignal<Runtime>();
  const [failed, setFailed] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [projection, setProjection] = createSignal<Projection>('mercator');
  const [region, setRegion] = createSignal<Region | undefined>(WORLD);
  const [lastFocus, setLastFocus] = createSignal(props.focusId);
  const shipments = createMemo(() => props.dashboard?.shipments ?? []);
  const views = createMemo(() => vesselViews(shipments(), now()));
  const ports = createMemo(() => fleetPorts(portFeatures(props.dashboard?.ports ?? [], props.dashboard?.portStatus, props.dashboard?.board), shipments()).features);
  const tick = window.setInterval(() => setNow(Date.now()), 4_000);
  onCleanup(() => window.clearInterval(tick));
  const frame = (map: MapLibreMap, bounds: Bounds, duration: number): void => {
    const { clientWidth, clientHeight } = map.getContainer();
    if (clientWidth === 0 || clientHeight === 0) return;
    const camera = cameraFor(bounds, clientWidth, clientHeight, 25);
    const zoom = untrack(projection) === 'globe' ? Math.max(camera.zoom, globeZoom(clientWidth, clientHeight, 25)) : camera.zoom;
    map.easeTo({ center: [...camera.center], zoom, duration });
  };
  onMount(() => {
    const host = container;
    if (!host) return;
    let disposed = false;
    let created: MapLibreMap | undefined;
    onCleanup(() => { disposed = true; created?.remove(); });
    void import('maplibre-gl').then(lib => {
      if (disposed) return;
      lib.setWorkerUrl(workerUrl);
      const base = style(window.location.origin);
      const map = new lib.Map({ container: host, style: { ...base, sources: { ...base.sources, sailed: { type: 'geojson', data: empty }, ahead: { type: 'geojson', data: empty } } }, center: [15, 18], zoom: 0.8, minZoom: 0, maxZoom: 9, attributionControl: false, dragRotate: false, pitchWithRotate: false });
      created = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.AttributionControl({ compact: true, customAttribution: 'Natural Earth · SeaRoute lanes · positions simulated' }), 'bottom-right');
      map.on('load', () => { if (!disposed) { const current = region(); if (current) frame(map, current.bounds, 0); setReady({ lib, map }); } });
      map.on('dragstart', () => setRegion(undefined));
      map.on('resize', () => { const current = region(); if (current) frame(map, current.bounds, 0); });
      map.on('error', event => { if (!disposed && 'sourceId' in event && event.sourceId === 'land') setFailed(true); });
    }).catch(() => { if (!disposed) setFailed(true); });
  });
  createEffect(() => {
    const current = ready();
    if (!current) return;
    current.map.setProjection({ type: projection() });
    const framed = untrack(region);
    if (framed) frame(current.map, framed.bounds, 500);
  });
  createEffect(() => {
    const current = ready();
    if (!current) return;
    const layers = routeLayers(views(), props.selected?.id);
    setFeatures(current.map, 'sailed', layers.sailed); setFeatures(current.map, 'ahead', layers.ahead);
  });
  createEffect(() => {
    const current = ready();
    const focus = props.focusId;
    if (!current || !focus || focus === lastFocus()) return;
    const selected = views().find(view => view.id === focus);
    const bounds = selected && boundsOf(selected.route);
    if (!bounds) return;
    setLastFocus(focus);
    setRegion(undefined);
    current.map.fitBounds(lngLatBounds(bounds), { padding: FRAME_PADDING, maxZoom: 4.2, duration: 700 });
  });
  return <div class="map-canvas operating-map gz-map">
    <div ref={container} class="map-gl" role="group" aria-label="Ship map. Select a ship to inspect its route. City badges show anchored ships, not arrivals or relevance." />
    <div class="gz-map-projection" role="group" aria-label="Map projection">
      <button type="button" aria-pressed={projection() === 'mercator'} onClick={() => setProjection('mercator')}>Map</button>
      <button type="button" aria-pressed={projection() === 'globe'} onClick={() => setProjection('globe')}>Globe</button>
    </div>
    <Menu.Root positioning={{ placement: 'bottom-end' }} onSelect={details => { const picked = regions.find(value => value.id === details.value); const map = ready()?.map; if (picked && map) { setRegion(picked); frame(map, picked.bounds, 700); } }}>
      <Menu.Trigger class="gz-map-region">{region()?.label ?? 'Region'}<ChevronDown size={16} /></Menu.Trigger>
      <Portal><Menu.Positioner><Menu.Content class="gz-map-region-menu">
        <Index each={regions}>{value => <Menu.Item value={value().id} class="gz-map-region-item" data-current={region()?.id === value().id ? '' : undefined}>{value().label}</Menu.Item>}</Index>
      </Menu.Content></Menu.Positioner></Portal>
    </Menu.Root>
    <Show when={ready()}>{runtime => <div class="gz-map-staging">
      <Index each={ports()}>{port => <MapMarker runtime={runtime()} position={port().geometry.coordinates}>
        <span class={`gz-city ${port().properties.risk}`} title={port().properties.label.replace('\n', ': ')} role="img" aria-label={port().properties.label.replace('\n', ': ')}>
          <Show when={port().properties.anchored !== null}><span class="gz-city-count">{port().properties.anchored}</span></Show>
          <Show when={props.selected?.destination === port().properties.id}><span class="gz-city-pill">{port().properties.name}</span></Show>
        </span>
      </MapMarker>}</Index>
      <Index each={views()}>{ship => {
        const selected = (): boolean => props.selected?.id === ship().id;
        const status = (): string => statusLine(ship());
        return <MapMarker runtime={runtime()} position={ship().position}>
          <button type="button" class={`gz-ship ${ship().risk}`} classList={{ selected: selected() }} aria-label={`${ship().vessel}, ${status()}`} aria-pressed={selected()} title={`${ship().vessel} · ${status()}`} onClick={() => props.onSelect(ship().id)}>
            <PixelShip />
            <RiskMark risk={ship().risk} />
            <Show when={selected()}>
              <svg class="gz-ship-brackets" viewBox="0 0 44 30" preserveAspectRatio="none" aria-hidden="true"><path d="M1 8V1h7M36 1h7v7M43 22v7h-7M8 29H1v-7" fill="none" stroke="currentColor" stroke-width="2" /></svg>
              <span class="gz-ship-label"><strong>{ship().vessel}</strong><span>{status()}</span></span>
            </Show>
          </button>
        </MapMarker>;
      }}</Index>
    </div>}</Show>
    <Show when={failed()}><p class="map-fallback" role="status">The map could not be drawn. The fleet list retains every ship and ETA.</p></Show>
    <p class="gz-map-hint">Drag to pan · Scroll to zoom</p>
  </div>;
}
const backdrop = new URL('./world-coastline.svg', import.meta.url).href;
export function MapBackdrop() { return <div class="map-canvas"><svg class="world-map" viewBox="0 30 1000 420" aria-hidden="true"><image href={backdrop} width="1000" height="500" /></svg></div>; }
