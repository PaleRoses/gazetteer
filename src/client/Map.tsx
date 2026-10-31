import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import type { GeoJSONSource, Map as MapLibreMap, Marker, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Dashboard, Shipment } from '../core/types';
import { boundsOf, graticule, routeLayers, vesselViews, type VesselView } from './map-model';

type MapLibre = typeof import('maplibre-gl');
type Selection = Readonly<{ dashboard: Dashboard | null; selected: Shipment | undefined; focusId: string | null; onSelect: (id: string) => void }>;

const COLOURS = { ocean: '#d6e6f2', land: '#f5f3ea', coast: '#8fb0c9', grid: '#9ebdd3', lane: '#5f87ad', route: '#1f5a9e' } as const;
const TICK_MS = 4_000;
const FRAME_PADDING = { top: 70, bottom: 150, left: 60, right: 110 } as const;
const OCEANS: readonly (readonly [string, number, number])[] = [['ATLANTIC OCEAN', -35, 25], ['PACIFIC OCEAN', -150, 10], ['PACIFIC OCEAN', 175, 5], ['INDIAN OCEAN', 78, -22]];
const RISK_TEXT = { 'on-track': 'on schedule', watch: 'watch', delayed: 'delayed' } as const;

const style = (origin: string): StyleSpecification => ({
  version: 8,
  sources: { land: { type: 'geojson', data: `${origin}/geo/land.geojson` }, graticule: { type: 'geojson', data: graticule(30) } },
  layers: [
    { id: 'ocean', type: 'background', paint: { 'background-color': COLOURS.ocean } },
    { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': COLOURS.grid, 'line-width': 0.5, 'line-opacity': 0.35 } },
    { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': COLOURS.land } },
    { id: 'coast', type: 'line', source: 'land', paint: { 'line-color': COLOURS.coast, 'line-width': 0.6 } },
  ],
});

const emptyLines: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const addRouteLayers = (map: MapLibreMap): void => {
  for (const id of ['lanes', 'sailed', 'ahead']) map.addSource(id, { type: 'geojson', data: emptyLines });
  map.addLayer({ id: 'lanes', type: 'line', source: 'lanes', layout: { 'line-cap': 'round' }, paint: { 'line-color': COLOURS.lane, 'line-width': 1.6, 'line-opacity': 0.75, 'line-dasharray': [2, 3] } });
  map.addLayer({ id: 'ahead-casing', type: 'line', source: 'ahead', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 0.75 } });
  map.addLayer({ id: 'ahead', type: 'line', source: 'ahead', layout: { 'line-join': 'round' }, paint: { 'line-color': COLOURS.route, 'line-width': 2.2, 'line-dasharray': [2, 2] } });
  map.addLayer({ id: 'sailed-casing', type: 'line', source: 'sailed', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 6, 'line-opacity': 0.8 } });
  map.addLayer({ id: 'sailed', type: 'line', source: 'sailed', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOURS.route, 'line-width': 3.2 } });
};

const SHIP_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1"/><path d="M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76"/><path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6"/><path d="M12 10v4"/><path d="M12 2v3"/></svg>';

const element = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const vesselElement = (onSelect: (id: string) => void, view: VesselView): HTMLButtonElement => {
  const button = element('button', 'vessel-marker') as HTMLButtonElement;
  button.type = 'button';
  const disc = element('span', 'vessel-disc');
  disc.innerHTML = SHIP_ICON;
  button.append(disc, element('span', 'vessel-alert', '!'), element('span', 'vessel-name', view.vessel));
  button.addEventListener('click', () => onSelect(view.id));
  return button;
};

const decorate = (button: HTMLElement, view: VesselView, selected: boolean): void => {
  button.classList.remove('on-track', 'watch', 'delayed', 'selected');
  button.classList.add(view.risk);
  button.classList.toggle('selected', selected);
  button.setAttribute('aria-label', `${view.vessel}, ${RISK_TEXT[view.risk]}${selected ? ', selected' : ''}`);
  button.setAttribute('aria-pressed', String(selected));
  button.style.zIndex = selected ? '3' : view.risk === 'on-track' ? '1' : '2';
};

const setLines = (map: MapLibreMap, id: string, data: GeoJSON.FeatureCollection): void => { (map.getSource(id) as GeoJSONSource | undefined)?.setData(data); };

export function ShipmentMap(props: Selection) {
  let container: HTMLDivElement | undefined;
  const [ready, setReady] = createSignal<Readonly<{ lib: MapLibre; map: MapLibreMap }> | null>(null);
  const [failed, setFailed] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const markers = new Map<string, Marker>();
  let framed: string | undefined;

  const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
  onCleanup(() => window.clearInterval(tick));

  onMount(() => {
    const host = container;
    if (!host) return;
    let disposed = false;
    let created: MapLibreMap | undefined;
    onCleanup(() => { disposed = true; markers.forEach(marker => marker.remove()); markers.clear(); created?.remove(); });
    void import('maplibre-gl').then(module => {
      if (disposed) return;
      const lib: MapLibre = 'default' in module ? (module as unknown as { default: MapLibre }).default : module;
      lib.setWorkerUrl(new URL(workerUrl, window.location.href).href);
      const map = new lib.Map({
        container: host, style: style(window.location.origin), center: [30, 24], zoom: 1.15, minZoom: 0.6, maxZoom: 7,
        attributionControl: false, dragRotate: false, pitchWithRotate: false,
      });
      created = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.AttributionControl({ compact: true, customAttribution: 'Natural Earth · Eurostat SeaRoute lanes · positions simulated' }), 'bottom-right');
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
      OCEANS.forEach(([name, lon, lat]) => new lib.Marker({ element: element('span', 'ocean-label', name), anchor: 'center' }).setLngLat([lon, lat]).addTo(map));
      map.on('load', () => { addRouteLayers(map); if (!disposed) setReady({ lib, map }); });
      map.on('error', event => { if (!disposed && (event as { sourceId?: string }).sourceId === 'land') setFailed(true); });
    }).catch(() => { if (!disposed) setFailed(true); });
  });

  const views = createMemo(() => vesselViews(props.dashboard?.shipments ?? [], now()));
  const selectedId = () => props.selected?.id;

  createEffect(() => {
    const current = ready();
    if (!current) return;
    const { lib, map } = current;
    const list = views();
    const chosen = selectedId();
    const layers = routeLayers(list, chosen);
    setLines(map, 'lanes', layers.lanes); setLines(map, 'sailed', layers.sailed); setLines(map, 'ahead', layers.ahead);
    const live = new Set(list.map(view => view.id));
    markers.forEach((marker, id) => { if (!live.has(id) && !id.startsWith('port:')) { marker.remove(); markers.delete(id); } });
    list.forEach(view => {
      const existing = markers.get(view.id);
      const marker = existing ?? new lib.Marker({ element: vesselElement(id => props.onSelect(id), view), anchor: 'center' }).setLngLat([...view.position]).addTo(map);
      if (!existing) markers.set(view.id, marker);
      marker.setLngLat([...view.position]);
      decorate(marker.getElement(), view, view.id === chosen);
    });
  });

  createEffect(() => {
    const current = ready();
    const dashboard = props.dashboard;
    if (!current || !dashboard) return;
    const { lib, map } = current;
    dashboard.ports.forEach(port => {
      const key = `port:${port.id}`;
      if (markers.has(key)) return;
      const node = element('div', 'port-marker');
      node.append(element('span', 'port-dot'), element('span', 'port-label', port.name));
      markers.set(key, new lib.Marker({ element: node, anchor: 'left', offset: [-4, 0] }).setLngLat([...port.coordinates] as [number, number]).addTo(map));
    });
  });

  createEffect(() => {
    const current = ready();
    const focus = props.focusId;
    if (!current || !focus || framed === focus) return;
    const view = views().find(item => item.id === focus);
    const bounds = view && boundsOf(view.route);
    if (!bounds) return;
    framed = focus;
    current.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: FRAME_PADDING, maxZoom: 4.2, duration: 900 });
  });

  return <div class="map-canvas">
    <div ref={container} class="map-gl" role="group" aria-label="Shipment map. Select a vessel with the markers or the shipment list." />
    <Show when={failed()}><p class="map-fallback" role="status">The map could not be drawn. The shipment list still shows every route and ETA.</p></Show>
    <div class="map-legend" aria-hidden="true"><span><i class="legend-dot on-track" />On schedule</span><span><i class="legend-dot watch" />Watch</span><span><i class="legend-dot delayed" />Delayed</span></div>
  </div>;
}

const backdrop = new URL('./world-coastline.svg', import.meta.url).href;
export function MapBackdrop() {
  return <div class="map-canvas"><svg class="world-map" viewBox="0 30 1000 420" aria-hidden="true"><image href={backdrop} width="1000" height="500" /></svg></div>;
}
