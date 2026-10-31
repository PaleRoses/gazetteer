import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from 'solid-js';
import type { GeoJSONSource, Map as MapLibreMap, Marker, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Dashboard, Shipment } from '../core/types';
import type { LngLat } from '../core/routes';
import { boundsOf, graticule, portFeatures, routeLayers, vesselViews } from './map-model';

type MapLibre = typeof import('maplibre-gl');
type Runtime = Readonly<{ lib: MapLibre; map: MapLibreMap }>;
type Selection = Readonly<{ dashboard: Dashboard | null; selected: Shipment | undefined; focusId: string | null; onSelect: (id: string) => void }>;
type Projection = 'mercator' | 'globe';
const COLOURS = { ocean: '#111315', land: '#1f211d', coast: '#3b3e37', grid: '#3b3e37', route: '#8cc3a1' } as const;
const RISK_COLOURS = { 'on-track': '#e8e4d6', watch: '#e0a03a', delayed: '#e5603f' } as const;
const PORT_COLOURS = { normal: '#e8e4d6', elevated: '#e0a03a', severe: '#e5603f', unreported: '#aaa99e' } as const;
const RISK_TEXT = { 'on-track': 'on schedule', watch: 'watch', delayed: 'delayed' } as const;
const FRAME_PADDING = { top: 90, bottom: 75, left: 70, right: 70 } as const;
const style = (origin: string): StyleSpecification => ({
  version: 8, projection: { type: 'mercator' },
  sources: { land: { type: 'geojson', data: `${origin}/geo/land.geojson` }, graticule: { type: 'geojson', data: graticule(30) } },
  layers: [
    { id: 'ocean', type: 'background', paint: { 'background-color': COLOURS.ocean } },
    { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': COLOURS.grid, 'line-width': 0.5, 'line-opacity': 0.12 } },
    { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': COLOURS.land } },
    { id: 'coast', type: 'line', source: 'land', paint: { 'line-color': COLOURS.coast, 'line-width': 0.7 } },
    { id: 'lanes', type: 'line', source: 'lanes', layout: { 'line-cap': 'round' }, paint: { 'line-color': ['match', ['get', 'risk'], 'watch', RISK_COLOURS.watch, 'delayed', RISK_COLOURS.delayed, RISK_COLOURS['on-track']], 'line-width': 1.4, 'line-opacity': 0.28, 'line-dasharray': [2, 4] } },
    { id: 'ahead', type: 'line', source: 'ahead', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOURS.route, 'line-width': 2.2, 'line-dasharray': [2, 2], 'line-opacity': 0.9 } },
    { id: 'sailed', type: 'line', source: 'sailed', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOURS.route, 'line-width': 2.5, 'line-opacity': 0.9 } },
  ],
});

/** One managed native marker per declarative child; no mutable marker registry or reconciliation loop. */
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
  return <div ref={element}>{props.children}</div>;
}
const setFeatures = (map: MapLibreMap, id: string, data: GeoJSON.FeatureCollection): void => { (map.getSource(id) as GeoJSONSource | undefined)?.setData(data); };
const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

export function ShipmentMap(props: Selection) {
  let container: HTMLDivElement | undefined;
  const [ready, setReady] = createSignal<Runtime>();
  const [failed, setFailed] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [projection, setProjection] = createSignal<Projection>('mercator');
  const [lastFocus, setLastFocus] = createSignal(props.focusId);
  const views = createMemo(() => vesselViews(props.dashboard?.shipments ?? [], now()));
  const ports = createMemo(() => portFeatures(props.dashboard?.ports ?? [], props.dashboard?.portStatus, props.dashboard?.board));
  const tick = window.setInterval(() => setNow(Date.now()), 4_000);
  onCleanup(() => window.clearInterval(tick));
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
      const map = new lib.Map({ container: host, style: { ...base, sources: { ...base.sources, lanes: { type: 'geojson', data: empty }, sailed: { type: 'geojson', data: empty }, ahead: { type: 'geojson', data: empty } } }, center: [15, 18], zoom: 0.8, minZoom: 0, maxZoom: 9, attributionControl: false, dragRotate: false, pitchWithRotate: false });
      created = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.AttributionControl({ compact: true, customAttribution: 'Natural Earth · SeaRoute lanes · positions simulated' }), 'bottom-right');
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-right');
      map.on('load', () => { if (!disposed) { map.fitBounds([[-180, -58], [180, 76]], { padding: 25, duration: 0 }); setReady({ lib, map }); } });
      map.on('error', event => { if (!disposed && 'sourceId' in event && event.sourceId === 'land') setFailed(true); });
    }).catch(() => { if (!disposed) setFailed(true); });
  });
  createEffect(() => { ready()?.map.setProjection({ type: projection() }); });
  createEffect(() => {
    const current = ready();
    if (!current) return;
    const layers = routeLayers(views(), props.selected?.id);
    setFeatures(current.map, 'lanes', layers.lanes); setFeatures(current.map, 'sailed', layers.sailed); setFeatures(current.map, 'ahead', layers.ahead);
  });
  createEffect(() => {
    const current = ready();
    const focus = props.focusId;
    if (!current || !focus || focus === lastFocus()) return;
    const selected = views().find(view => view.id === focus);
    const bounds = selected && boundsOf(selected.route);
    if (!bounds) return;
    setLastFocus(focus);
    current.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: FRAME_PADDING, maxZoom: 4.2, duration: 700 });
  });
  return <div class="map-canvas operating-map">
    <div ref={container} class="map-gl" role="group" aria-label="Ship map. Select a ship to inspect its route. City badges show anchored ships, not arrivals or relevance." />
    <div class="map-projection" role="group" aria-label="Map projection" style={{ position: 'absolute', top: '18px', left: '18px', display: 'flex', gap: '4px', 'z-index': '3' }}><button type="button" aria-pressed={projection() === 'mercator'} onClick={() => setProjection('mercator')}>Map</button><button type="button" aria-pressed={projection() === 'globe'} onClick={() => setProjection('globe')}>Globe</button></div>
    <button type="button" class="map-whole-world" style={{ position: 'absolute', top: '18px', right: '18px', 'z-index': '3' }} onClick={() => ready()?.map.fitBounds([[-180, -58], [180, 76]], { padding: 25, duration: 700 })}>Whole world</button>
    <Show when={ready()}>{runtime => <div style={{ display: 'none' }}>
      <For each={ports().features}>{port => <MapMarker runtime={runtime()} position={port.geometry.coordinates}><span class="city-marker" title={port.properties.label.replace('\n', ': ')} role="img" aria-label={port.properties.label.replace('\n', ': ')} style={{ position: 'relative', display: 'block', width: '10px', height: '10px', border: `1px solid ${PORT_COLOURS[port.properties.risk]}`, background: port.properties.risk === 'unreported' ? '#111315' : PORT_COLOURS[port.properties.risk] }}><Show when={port.properties.anchored !== null}><span class="city-count" style={{ position: 'absolute', left: '12px', top: '-9px', 'border-radius': '50%', background: PORT_COLOURS[port.properties.risk], color: '#111315', 'font-size': '10px', 'font-weight': '700', 'min-width': '15px', height: '15px', 'text-align': 'center', 'line-height': '15px' }}>{port.properties.anchored}</span></Show></span></MapMarker>}</For>
      <For each={views()}>{ship => <MapMarker runtime={runtime()} position={ship.position}><button type="button" class={`pixel-vessel ${ship.risk}${props.selected?.id === ship.id ? ' selected' : ''}`} aria-label={`${ship.vessel}, ${RISK_TEXT[ship.risk]}`} aria-pressed={props.selected?.id === ship.id} title={`${ship.vessel} · ${RISK_TEXT[ship.risk]}`} onClick={() => props.onSelect(ship.id)} style={{ position: 'relative', padding: '5px', color: RISK_COLOURS[ship.risk], background: 'transparent', border: props.selected?.id === ship.id ? '1px solid #8cc3a1' : '1px solid transparent' }}>
        <svg class="pixel-ship" width="30" height="20" viewBox="0 0 15 10" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M6 0h1v2h3v3h3v1h2v2h-2v1H2V8H0V6h3V3h3zm-1 4v1h2V4zm3 0v1h1V4z" /></svg>
        <Show when={ship.risk !== 'on-track'}><span class="pixel-vessel-alert" aria-hidden="true" style={{ position: 'absolute', top: '-7px', right: '-7px', color: RISK_COLOURS[ship.risk] }}>{ship.risk === 'watch' ? '▲' : '!'}</span></Show>
        <Show when={props.selected?.id === ship.id}><span class="pixel-vessel-name" style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', color: '#e8e4d6', 'white-space': 'nowrap', 'font-size': '11px' }}>{ship.vessel}</span></Show>
      </button></MapMarker>}</For>
    </div>}</Show>
    <Show when={failed()}><p class="map-fallback" role="status">The map could not be drawn. The fleet list retains every ship and ETA.</p></Show>
    <p class="map-interaction-hint" style={{ position: 'absolute', bottom: '18px', width: '100%', 'text-align': 'center', color: '#aaa99e', 'font-size': '11px', 'pointer-events': 'none' }}>Drag to pan · Scroll to zoom</p>
  </div>;
}
const backdrop = new URL('./world-coastline.svg', import.meta.url).href;
export function MapBackdrop() { return <div class="map-canvas"><svg class="world-map" viewBox="0 30 1000 420" aria-hidden="true"><image href={backdrop} width="1000" height="500" /></svg></div>; }
