import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack } from 'solid-js';
import { Portal } from 'solid-js/web';
import { riskLabel, shipmentBrief } from './brief';
import { WarningDetails } from './WarningDetails';
import { PortDetails } from './PortDetails';
import type { GeoJSONSource, Map as MapLibreMap, Marker, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Dashboard, Diversion, MonitoredRoute, Port, Shipment } from '../shared';
import { boundsOf, graticule, routeLayers, vesselViews, type VesselView } from './map-model';

type MapLibre = typeof import('maplibre-gl');
type Selection = Readonly<{ dashboard: Dashboard | null; selected: Shipment | undefined; focusId: string | null; onSelect: (id: string) => void; onOpen: () => void; onDismiss: () => void; showPopup: boolean; inspected: Diversion | null; corridor?: MonitoredRoute; routeMode?: boolean; onRoute: (id: string) => void }>;

const COLOURS = { ocean: '#d6e6f2', land: '#f5f3ea', coast: '#8fb0c9', grid: '#9ebdd3', lane: '#5f87ad', route: '#1f5a9e' } as const;
const TICK_MS = 4_000;
const FRAME_PADDING = { top: 70, bottom: 150, left: 60, right: 110 } as const;
const OCEANS: readonly (readonly [string, number, number])[] = [['ATLANTIC OCEAN', -35, 25], ['PACIFIC OCEAN', -150, 10], ['PACIFIC OCEAN', 175, 5], ['INDIAN OCEAN', 78, -22]];
const RISK_TEXT = riskLabel;

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
  for (const id of ['lanes', 'sailed', 'ahead', 'corridors', 'alternative']) map.addSource(id, { type: 'geojson', data: emptyLines });
  map.addLayer({ id: 'corridors', type: 'line', source: 'corridors', paint: { 'line-color': '#225f9e', 'line-width': 5, 'line-opacity': 0.7 } });
  map.addLayer({ id: 'corridor-hit', type: 'line', source: 'corridors', paint: { 'line-color': '#225f9e', 'line-width': 24, 'line-opacity': 0.01 } });
  map.addLayer({ id: 'alternative', type: 'line', source: 'alternative', paint: { 'line-color': '#8755a4', 'line-width': 2, 'line-dasharray': [3, 3] } });
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
  const [warningHost, setWarningHost] = createSignal<HTMLElement>();
  let warningPopup: import('maplibre-gl').Popup | undefined;
  const [warningId, setWarningId] = createSignal<string | null>(null);
  const [portPlace, setPortPlace] = createSignal<Port | Diversion | null>(null);
  let warningTrigger: HTMLElement | null = null;
  const warning = createMemo(() => (props.corridor?.intelligence ?? props.dashboard?.intelligence)?.items.find(item => item.evidence.id === warningId()));
  // Preserve the popup's DOM host across live dashboard refreshes at the same location.
  const detailPosition = createMemo(() => warning()?.coordinates ?? portPlace()?.coordinates, undefined, {
    equals: (left, right) => left?.[0] === right?.[0] && left?.[1] === right?.[1],
  });
  const [frameWidth, setFrameWidth] = createSignal(0);
  const [popupHost, setPopupHost] = createSignal<HTMLElement | undefined>();
  let popup: import('maplibre-gl').Popup | undefined;


  const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
  onCleanup(() => window.clearInterval(tick));

  onMount(() => {
    const host = container;
    if (!host) return;
    let disposed = false;
    let created: MapLibreMap | undefined;
    const resize = new ResizeObserver(() => { created?.resize(); setFrameWidth(host.clientWidth); });
    resize.observe(host);
    onCleanup(() => { resize.disconnect(); popup?.remove(); disposed = true; markers.forEach(marker => marker.remove()); markers.clear(); created?.remove(); });
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
      map.addControl(new lib.AttributionControl({ compact: true, customAttribution: 'Natural Earth · Approximate voyage paths · positions simulated' }), 'bottom-right');
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
      OCEANS.forEach(([name, lon, lat]) => new lib.Marker({ element: element('span', 'ocean-label', name), anchor: 'center' }).setLngLat([lon, lat]).addTo(map));
      map.on('load', () => {
        addRouteLayers(map);
        map.on('click', 'corridor-hit', event => { const id = event.features?.[0]?.properties?.id; if (typeof id === 'string') props.onRoute(id); });
        map.on('mouseenter', 'corridor-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'corridor-hit', () => { map.getCanvas().style.cursor = ''; });
        if (!disposed) setReady({ lib, map });
      });
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
    markers.forEach((marker, id) => { if (!live.has(id) && !id.includes(':')) { marker.remove(); markers.delete(id); } });
    list.forEach(view => {
      const existing = markers.get(view.id);
      const marker = existing ?? new lib.Marker({ element: vesselElement(id => { setWarningId(null); setPortPlace(null); props.onSelect(id); }, view), anchor: 'center' }).setLngLat([...view.position]).addTo(map);
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
    const portKeys = new Set(dashboard.ports.map(port => `port:${port.id}`));
    markers.forEach((marker, key) => { if (key.startsWith('port:') && !portKeys.has(key)) { marker.remove(); markers.delete(key); } });
    dashboard.ports.forEach(port => {
      const key = `port:${port.id}`;
      if (markers.has(key)) return;
      const node = element('button', 'port-marker');
      node.setAttribute('type', 'button'); node.setAttribute('aria-label', `${port.name} port details`); node.setAttribute('aria-haspopup', 'dialog'); node.dataset.portId = port.id;
      node.addEventListener('click', event => { event.stopPropagation(); props.onDismiss(); setWarningId(null); warningTrigger = node; setPortPlace(port); map.panTo([...port.coordinates], { duration: 250 }); });
      node.append(element('span', 'port-dot'), element('span', 'port-label', port.name));
      markers.set(key, new lib.Marker({ element: node, anchor: 'left', offset: [-4, 0] }).setLngLat([...port.coordinates] as [number, number]).addTo(map));
    });
  });

  createEffect(() => {
    const current = ready();
    if (!current) return;
    const corridors = props.corridor ? [props.corridor] : props.routeMode ? props.dashboard?.routes ?? [] : [];
    setLines(current.map, 'corridors', { type: 'FeatureCollection', features: corridors.filter(r => r.path.length > 1).map(r => ({ type: 'Feature', properties: { id: r.id }, geometry: { type: 'LineString', coordinates: r.path.map(p => [...p]) } })) });
  });
  createEffect(() => {
    const current = ready();
    if (!current) return;
    const option = props.inspected;
    const key = `${frameWidth()}:` + (option ? `alternative:${option.id}` : props.corridor ? `route:${props.corridor.id}` : props.focusId ?? 'fleet');
    if (key === framed) return;
    const focus = views().find(v => v.id === props.focusId);
    const path = option ? [option.coordinates, props.dashboard?.ports.find(p => p.id === option.replaces)?.coordinates ?? option.coordinates] : props.corridor?.path ?? focus?.route ?? [];
    const bounds = boundsOf(path);
    const narrow = (container?.clientWidth ?? 500) < 500;
    if (bounds) current.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: narrow ? { top: 90, bottom: 160, left: 35, right: 35 } : FRAME_PADDING, maxZoom: option ? 6 : 4.2, duration: 600 });
    else current.map.fitBounds([[-180, -50], [180, 65]], { padding: 40, duration: 600 });
    framed = key;
  });
  createEffect(() => {
    const current = ready();
    const selected = props.selected;
    if (!current || !selected || !props.showPopup) { popup?.remove(); popup = undefined; setPopupHost(undefined); return; }
    const host = document.createElement('div');
    const position = untrack(() => views().find(v => v.id === selected.id)?.position) ?? selected.coordinates;
    popup?.remove();
    const created = new current.lib.Popup({ closeButton: false, closeOnClick: false, offset: 20, maxWidth: '290px', className: 'shipment-popup' }).setLngLat([...position]).setDOMContent(host).addTo(current.map);
    popup = created; setPopupHost(host);
    onCleanup(() => created.remove());
  });
  createEffect(() => {
    const position = views().find(v => v.id === props.selected?.id)?.position;
    if (position) popup?.setLngLat([...position]);
  });
  createEffect(() => {
    const current = ready();
    if (!current) return;
    const info = props.corridor?.intelligence ?? props.dashboard?.intelligence;
    const alternatives = props.inspected ? [props.inspected] : (info?.diversions ?? []).filter(d => props.corridor || d.shipmentId === props.selected?.id);
    const owned: Marker[] = [];
    for (const option of [...new Map(alternatives.map(d => [d.name, d])).values()]) {
      const node = element('button', 'alternative-port');
      node.setAttribute('type', 'button'); node.setAttribute('aria-label', `${option.name} alternative port details`); node.setAttribute('aria-haspopup', 'dialog'); node.dataset.portId = option.id;
      node.addEventListener('click', event => { event.stopPropagation(); props.onDismiss(); setWarningId(null); warningTrigger = node; setPortPlace(option); current.map.panTo([...option.coordinates], { duration: 250 }); });
      node.append(element('span', 'alternative-dot'), element('span', '', option.name));
      owned.push(new current.lib.Marker({ element: node }).setLngLat([...option.coordinates]).addTo(current.map));
    }
    for (const item of info?.items ?? []) {
      if (!item.coordinates || (!props.corridor && props.selected && !item.relevance.some(r => r.shipmentId === props.selected?.id))) continue;
      const node = element('button', 'news-marker', '!'); node.setAttribute('aria-label', item.evidence.title); node.title = item.evidence.title;
      node.setAttribute('type', 'button'); node.setAttribute('aria-haspopup', 'dialog');
      node.dataset.warningId = item.evidence.id;
      node.addEventListener('click', event => { event.stopPropagation(); props.onDismiss(); setPortPlace(null); warningTrigger = node; setWarningId(item.evidence.id); current.map.panTo([...item.coordinates!], { duration: 250 }); });
      owned.push(new current.lib.Marker({ element: node }).setLngLat([...item.coordinates]).addTo(current.map));
    }
    const option = props.inspected;
    const port = props.dashboard?.ports.find(p => p.id === option?.replaces);
    setLines(current.map, 'alternative', { type: 'FeatureCollection', features: option && port ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[...port.coordinates], [...option.coordinates]] } }] : [] });
    onCleanup(() => owned.forEach(m => m.remove()));
  });


  const closeWarning = () => {
    setWarningId(null); setPortPlace(null);
    const trigger = warningTrigger?.isConnected ? warningTrigger : container?.querySelector<HTMLElement>(warningTrigger?.dataset.portId ? `button[data-port-id="${CSS.escape(warningTrigger.dataset.portId)}"]` : `button[data-warning-id="${CSS.escape(warningTrigger?.dataset.warningId ?? '')}"]`);
    trigger?.focus({ preventScroll: true });
  };
  createEffect(() => {
    const current = ready();
    const position = detailPosition();
    if (!current || !position) { warningPopup?.remove(); warningPopup = undefined; setWarningHost(undefined); return; }
    const host = document.createElement('div');
    host.style.setProperty('--warning-max-height', `${Math.max(180, Math.min(330, current.map.getContainer().clientHeight / 2 - 40))}px`);
    const created = new current.lib.Popup({ closeButton: false, closeOnClick: false, offset: 18, maxWidth: '340px', className: 'warning-popup' })
      .setLngLat([...position]).setDOMContent(host).addTo(current.map);
    warningPopup = created; setWarningHost(host);
    onCleanup(() => created.remove());
  });

  return <div class="map-canvas">
    <Show keyed when={warningHost()}>{host => <Portal mount={host}><Show when={portPlace()} fallback={<WarningDetails item={warning()} dashboard={props.dashboard} onClose={closeWarning} onShip={props.onSelect} onLayout={() => { const position = warning()?.coordinates; if (position) warningPopup?.setLngLat([...position]); }} />}>{place => <PortDetails place={place()} dashboard={props.dashboard} onClose={closeWarning} onShip={props.onSelect} onLayout={() => warningPopup?.setLngLat([...place().coordinates])} />}</Show></Portal>}</Show>
    <div ref={container} class="map-gl" tabIndex={-1} role="group" aria-label="Shipment map. Select a vessel with the markers or the shipment list." />
    <Show when={popupHost()}>{host => <Portal mount={host()}><button class="popup-dismiss" aria-label="Close ship popup" onClick={props.onDismiss}>×</button><button class="popup-open" onClick={props.onOpen}><span class="reference">{props.selected?.reference}</span><strong>{props.selected?.vessel}</strong><span class="popup-eta">ETA {props.selected && new Date(props.selected.eta).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC</span><span class={`risk-badge ${props.selected?.risk}`}>{props.selected && riskLabel[props.selected.risk]}</span><span class="popup-brief">{props.selected && shipmentBrief(props.selected).text}</span><span class="popup-source">{props.selected && shipmentBrief(props.selected).source}</span><span class="popup-cta">Open voyage briefing →</span></button></Portal>}</Show>
    <Show when={props.inspected}><div class="alternative-map-caption">{props.inspected?.name} · indicative connection; revised ETA unconfirmed</div></Show>
    <Show when={failed()}><p class="map-fallback" role="status">The map could not be drawn. The shipment list still shows every route and ETA.</p></Show>
    <div class="map-legend" aria-hidden="true"><span><i class="legend-dot on-track" />Low risk</span><span><i class="legend-dot watch" />Moderate risk</span><span><i class="legend-dot delayed" />High risk</span></div>
  </div>;
}

const backdrop = new URL('./world-coastline.svg', import.meta.url).href;
export function MapBackdrop() {
  return <div class="map-canvas"><svg class="world-map" viewBox="0 30 1000 420" aria-hidden="true"><image href={backdrop} width="1000" height="500" /></svg></div>;
}
