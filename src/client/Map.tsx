import { createEffect, createMemo, createSignal, Index, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Menu } from '@ark-ui/solid';
import { ChevronDown } from 'lucide-solid';
import type { GeoJSONSource, Map as MapLibreMap, Marker, Popup, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Dashboard, Diversion, MonitoredRoute, Port, Shipment } from '../core/types';
import type { LngLat } from '../core/routes';
import { boundsOf, cameraFor, fleetPorts, globeZoom, portFeatures, regions, routeLayers, statusLine, vesselViews, type Bounds, type Region } from './map-model';
import { PixelShip, riskColour, RiskMark, selectionColour } from './sprites';
import './styles/map.css';
import { riskLabel, shipmentBrief } from './brief';
import { WarningDetails } from './WarningDetails';
import { WarningGroup } from './WarningGroup';
import { clusterWarnings } from './warning-clusters';
import { warningLabel, warningTone } from './warning-severity';
import { PortDetails } from './PortDetails';
import { MapLegend, type MapLayer, type MapVisibility } from './MapLegend';
import './warning-markers.css';

type MapLibre = typeof import('maplibre-gl');
type Runtime = Readonly<{ lib: MapLibre; map: MapLibreMap }>;
type Selection = Readonly<{ dashboard: Dashboard | null; selected: Shipment | undefined; focusId: string | null; onSelect: (id: string) => void; onOpen: () => void; onDismiss: () => void; onClear: () => void; showPopup: boolean; inspected: Diversion | null; corridor?: MonitoredRoute; routeMode?: boolean; onRoute: (id: string) => void }>;
type Projection = 'mercator' | 'globe';
const COLOURS = { ocean: '#0b0b0b', land: '#2a2a2a', coast: '#4a4a4a', corridor: '#d8d8d8', alternative: '#b9a7d6' } as const;
const FRAME_PADDING = { top: 90, bottom: 75, left: 70, right: 70 } as const;
const WORLD = regions[0];
const style = (origin: string): StyleSpecification => ({
  version: 8, projection: { type: 'mercator' },
  sources: { land: { type: 'geojson', data: `${origin}/geo/land.geojson` } },
  layers: [
    { id: 'ocean', type: 'background', paint: { 'background-color': COLOURS.ocean } },
    { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': COLOURS.land } },
    { id: 'coast', type: 'line', source: 'land', layout: { 'line-join': 'round' }, paint: { 'line-color': COLOURS.coast, 'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.7, 4, 1.1, 9, 1.8] } },
    { id: 'corridors', type: 'line', source: 'corridors', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOURS.corridor, 'line-width': 5, 'line-opacity': 0.3 } },
    { id: 'corridor-hit', type: 'line', source: 'corridors', paint: { 'line-color': COLOURS.corridor, 'line-width': 24, 'line-opacity': 0.01 } },
    { id: 'alternative', type: 'line', source: 'alternative', paint: { 'line-color': COLOURS.alternative, 'line-width': 2, 'line-dasharray': [3, 3] } },
    { id: 'voyages', type: 'line', source: 'voyages', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'risk'], 'delayed', riskColour.delayed, 'watch', riskColour.watch, riskColour['on-track']], 'line-width': 1.2, 'line-opacity': 0.22 } },
    { id: 'lanes', type: 'line', source: 'lanes', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['match', ['get', 'risk'], 'delayed', riskColour.delayed, 'watch', riskColour.watch, riskColour['on-track']], 'line-width': 1.4, 'line-dasharray': [2, 2.5], 'line-opacity': 0.5 } },
    { id: 'sailed', type: 'line', source: 'sailed', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': selectionColour, 'line-width': 2, 'line-dasharray': [0.1, 2.6], 'line-opacity': 0.45 } },
    { id: 'ahead', type: 'line', source: 'ahead', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': selectionColour, 'line-width': 2.4, 'line-dasharray': [0.1, 2.4], 'line-opacity': 0.95 } },
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
const element = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const lngLatBounds = (bounds: Bounds): [[number, number], [number, number]] => [[bounds[0], bounds[1]], [bounds[2], bounds[3]]];

export function ShipmentMap(props: Selection) {
  let container: HTMLDivElement | undefined;
  const [ready, setReady] = createSignal<Runtime>();
  const [failed, setFailed] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [projection, setProjection] = createSignal<Projection>('mercator');
  const [visible, setVisible] = createSignal<MapVisibility>({ ships: true, routes: true, ports: true, warnings: true, diversions: true });
  const [region, setRegion] = createSignal<Region | undefined>(WORLD);
  const [lastFocus, setLastFocus] = createSignal(props.focusId);
  const shipments = createMemo(() => props.dashboard?.shipments ?? []);
  const views = createMemo(() => vesselViews(shipments(), now()));
  const ports = createMemo(() => fleetPorts(portFeatures(props.dashboard?.ports ?? [], props.dashboard?.portStatus, props.dashboard?.board), shipments()).features);
  let framed: string | null = null;
  const [warningHost, setWarningHost] = createSignal<HTMLElement>();
  let warningPopup: Popup | undefined;
  const [warningGroup, setWarningGroup] = createSignal<{ ids: readonly string[]; coordinates: readonly [number, number] } | null>(null);
  const [warningId, setWarningId] = createSignal<string | null>(null);
  const [portPlace, setPortPlace] = createSignal<Port | Diversion | null>(null);
  let warningTrigger: HTMLElement | null = null;
  const visibleWarnings = createMemo(() => (props.corridor?.intelligence ?? props.dashboard?.intelligence)?.items.filter(item => item.coordinates && (props.corridor || !props.selected || item.relevance.some(r => r.shipmentId === props.selected?.id))) ?? []);
  const warning = createMemo(() => visibleWarnings().find(item => item.evidence.id === warningId()));
  const groupedWarnings = createMemo(() => visibleWarnings().filter(item => warningGroup()?.ids.includes(item.evidence.id)));
  // Preserve the popup's DOM host across live dashboard refreshes at the same location.
  const detailPosition = createMemo(() => warning()?.coordinates ?? portPlace()?.coordinates ?? (groupedWarnings().length ? warningGroup()?.coordinates : undefined), undefined, {
    equals: (left, right) => left?.[0] === right?.[0] && left?.[1] === right?.[1],
  });
  const [popupHost, setPopupHost] = createSignal<HTMLElement | undefined>();
  let popup: Popup | undefined;
  const clearDetails = (): void => { setWarningGroup(null); setWarningId(null); setPortPlace(null); };
  const toggleLayer = (layer: MapLayer, shown: boolean): void => {
    setVisible(previous => ({ ...previous, [layer]: shown }));
    if (shown) return;
    if (layer === 'ships') props.onDismiss();
    if (layer === 'warnings') { setWarningId(null); setWarningGroup(null); }
    const place = portPlace();
    if (place && layer === ('replaces' in place ? 'diversions' : 'ports')) setPortPlace(null);
  };
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
    const resize = new ResizeObserver(() => { created?.resize(); });
    resize.observe(host);
    onCleanup(() => { resize.disconnect(); popup?.remove(); warningPopup?.remove(); disposed = true; created?.remove(); });
    void import('maplibre-gl').then(lib => {
      if (disposed) return;
      lib.setWorkerUrl(workerUrl);
      const base = style(window.location.origin);
      const map = new lib.Map({ container: host, style: { ...base, sources: { ...base.sources, voyages: { type: 'geojson', data: empty }, lanes: { type: 'geojson', data: empty }, sailed: { type: 'geojson', data: empty }, ahead: { type: 'geojson', data: empty }, corridors: { type: 'geojson', data: empty }, alternative: { type: 'geojson', data: empty } } }, center: [15, 18], zoom: 0.8, minZoom: 0, maxZoom: 9, attributionControl: false, dragRotate: false, pitchWithRotate: false });
      created = map;
      const updatePortLabels = () => host.classList.toggle('port-labels-visible', map.getZoom() >= 4);
      updatePortLabels();
      map.on('zoom', updatePortLabels);
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.AttributionControl({ compact: true, customAttribution: 'Natural Earth · SeaRoute lanes · positions simulated' }), 'bottom-right');
      map.on('load', () => {
        map.on('click', event => {
          // HTML markers, popovers and controls keep their own click behavior.
          if (event.originalEvent.target !== map.getCanvas() || map.queryRenderedFeatures(event.point, { layers: ['corridor-hit'] }).length) return;
          clearDetails();
          props.onClear();
        });
        map.on('click', 'corridor-hit', event => { const id = event.features?.[0]?.properties?.id; if (typeof id === 'string') props.onRoute(id); });
        map.on('mouseenter', 'corridor-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'corridor-hit', () => { map.getCanvas().style.cursor = ''; });
        if (!disposed) { const current = region(); if (current) frame(map, current.bounds, 0); setReady({ lib, map }); }
      });
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
    const map = ready()?.map;
    if (!map) return;
    for (const id of ['voyages', 'lanes', 'sailed', 'ahead', 'corridors', 'corridor-hit']) {
      map.setLayoutProperty(id, 'visibility', visible().routes ? 'visible' : 'none');
    }
    map.setLayoutProperty('alternative', 'visibility', visible().routes && visible().diversions ? 'visible' : 'none');
    if (!visible().routes) map.getCanvas().style.cursor = '';
  });
  createEffect(() => {
    const current = ready();
    if (!current) return;
    const layers = routeLayers(views(), props.selected?.id);
    setFeatures(current.map, 'voyages', layers.voyages); setFeatures(current.map, 'lanes', layers.lanes); setFeatures(current.map, 'sailed', layers.sailed); setFeatures(current.map, 'ahead', layers.ahead);
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

  createEffect(() => {
    const current = ready();
    if (!current) return;
    const corridors = props.corridor ? [props.corridor] : props.routeMode ? props.dashboard?.routes ?? [] : [];
    setFeatures(current.map, 'corridors', { type: 'FeatureCollection', features: corridors.filter(r => r.path.length > 1).map(r => ({ type: 'Feature', properties: { id: r.id }, geometry: { type: 'LineString', coordinates: r.path.map(p => [...p]) } })) });
  });
  createEffect(() => {
    const current = ready();
    if (!current) return;
    const option = props.inspected;
    const key = option ? `alternative:${option.id}` : props.corridor ? `route:${props.corridor.id}` : null;
    if (key === framed) return;
    const was = framed;
    framed = key;
    if (key === null) { if (was !== null && WORLD) { setRegion(WORLD); frame(current.map, WORLD.bounds, 600); } return; }
    const path = option ? [option.coordinates, props.dashboard?.ports.find(p => p.id === option.replaces)?.coordinates ?? option.coordinates] : props.corridor?.path ?? [];
    const bounds = boundsOf(path);
    if (!bounds) return;
    setRegion(undefined);
    const narrow = (container?.clientWidth ?? 500) < 500;
    current.map.fitBounds(lngLatBounds(bounds), { padding: narrow ? { top: 90, bottom: 160, left: 35, right: 35 } : FRAME_PADDING, maxZoom: option ? 6 : 4.2, duration: 600 });
  });
  createEffect(() => {
    const current = ready();
    const selected = props.selected;
    if (!current || !selected || !props.showPopup || !visible().ships) { popup?.remove(); popup = undefined; setPopupHost(undefined); return; }
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
    const alternatives = !visible().diversions ? [] : props.inspected ? [props.inspected] : (info?.diversions ?? []).filter(d => props.corridor || d.shipmentId === props.selected?.id);
    const owned: Marker[] = [];
    for (const option of [...new Map(alternatives.map(d => [d.name, d])).values()]) {
      const node = element('button', 'alternative-port');
      node.setAttribute('type', 'button'); node.setAttribute('aria-label', `${option.name} alternative port details`); node.setAttribute('aria-haspopup', 'dialog'); node.dataset.portId = option.id;
      node.addEventListener('click', event => { event.stopPropagation(); props.onDismiss(); setWarningGroup(null); setWarningId(null); warningTrigger = node; setPortPlace(option); current.map.panTo([...option.coordinates], { duration: 250, offset: [0, current.map.getContainer().clientHeight / 2 - 32] }); });
      node.append(element('span', 'alternative-dot'), element('span', 'port-label', option.name));
      owned.push(new current.lib.Marker({ element: node }).setLngLat([...option.coordinates]).addTo(current.map));
    }
    const option = props.inspected;
    const port = props.dashboard?.ports.find(p => p.id === option?.replaces);
    setFeatures(current.map, 'alternative', { type: 'FeatureCollection', features: option && port ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[...port.coordinates], [...option.coordinates]] } }] : [] });
    onCleanup(() => owned.forEach(m => m.remove()));
  });
  createEffect(() => {
    const current = ready();
    if (!current) return;
    if (!visible().warnings) return;
    const items = visibleWarnings();
    const { map, lib } = current;
    let owned: Marker[] = [];
    const render = () => {
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.warningId : undefined;
      owned.forEach(marker => marker.remove());
      owned = [];
      const center = map.getCenter().lng;
      const groups = clusterWarnings(items, ([lon, lat]) => map.project([lon + 360 * Math.round((center - lon) / 360), lat]));
      for (const group of groups) {
        const multi = group.items.length > 1;
        const item = group.items[0]!;
        const location = map.unproject([group.center.x, group.center.y]);
        const coordinates: readonly [number, number] = [location.lng, location.lat];
        const node = element('button', `news-marker warning-${warningTone(group.severity)}${multi ? ' news-cluster' : ''}`);
        const glyph = element('span', 'warning-mark', '!');
        glyph.setAttribute('aria-hidden', 'true');
        node.append(glyph);
        if (multi) {
          const count = element('span', 'warning-count', String(group.items.length));
          count.setAttribute('aria-hidden', 'true');
          node.append(count);
        }
        node.setAttribute('type', 'button'); node.setAttribute('aria-haspopup', 'dialog');
        node.setAttribute('aria-label', multi ? `${group.items.length} warnings in this area; highest: ${warningLabel(group.severity)}` : `${warningLabel(group.severity)} warning: ${item.evidence.title}`);
        node.title = multi ? `${group.items.length} warnings · Highest: ${warningLabel(group.severity)} — click to explore` : `${warningLabel(group.severity)} · ${item.evidence.title}`;
        node.dataset.warningId = multi ? group.id : item.evidence.id;
        node.addEventListener('click', event => {
          event.stopPropagation(); props.onDismiss(); setPortPlace(null); warningTrigger = node;
          setWarningId(multi ? null : item.evidence.id);
          setWarningGroup(multi ? { ids: group.items.map(item => item.evidence.id), coordinates } : null);
          map.panTo([...coordinates], { duration: 250 });
        });
        owned.push(new lib.Marker({ element: node }).setLngLat([...coordinates]).addTo(map));
        if (focused === node.dataset.warningId) node.focus({ preventScroll: true });
      }
    };
    render();
    map.on('moveend', render); map.on('resize', render);
    onCleanup(() => { map.off('moveend', render); map.off('resize', render); owned.forEach(marker => marker.remove()); });
  });
  const closeWarning = () => {
    clearDetails();
    const trigger = warningTrigger?.isConnected ? warningTrigger : container?.querySelector<HTMLElement>(warningTrigger?.dataset.portId ? `button[data-port-id="${CSS.escape(warningTrigger.dataset.portId)}"]` : `button[data-warning-id="${CSS.escape(warningTrigger?.dataset.warningId ?? '')}"]`);
    (trigger ?? container)?.focus({ preventScroll: true });
  };
  createEffect(() => {
    const current = ready();
    const position = detailPosition();
    if (!current || !position) { warningPopup?.remove(); warningPopup = undefined; setWarningHost(undefined); return; }
    const host = document.createElement('div');
    host.style.setProperty('--warning-max-height', `${Math.max(180, portPlace() ? Math.min(330, current.map.getContainer().clientHeight - 80) : Math.min(330, current.map.getContainer().clientHeight / 2 - 40))}px`);
    const created = new current.lib.Popup({ closeButton: false, closeOnClick: false, offset: 18, ...(portPlace() ? { anchor: 'bottom' as const } : {}), maxWidth: '340px', className: 'warning-popup' })
      .setLngLat([...position]).setDOMContent(host).addTo(current.map);
    warningPopup = created; setWarningHost(host);
    onCleanup(() => created.remove());
  });
  const openPort = (event: MouseEvent & { currentTarget: HTMLButtonElement }, id: Port['id']): void => {
    event.stopPropagation();
    const place = props.dashboard?.ports.find(port => port.id === id);
    if (!place) return;
    props.onDismiss(); setWarningGroup(null); setWarningId(null);
    warningTrigger = event.currentTarget; setPortPlace(place);
    const map = ready()?.map;
    map?.panTo([...place.coordinates], { duration: 250, offset: [0, map.getContainer().clientHeight / 2 - 32] });
  };
  return <div class="map-canvas operating-map gz-map">
    <Show keyed when={warningHost()}>{host => <Portal mount={host}>
      <Show when={portPlace()} fallback={
        <Show when={warning()} fallback={<WarningGroup items={groupedWarnings()} onClose={closeWarning} onSelect={setWarningId} onLayout={() => { const position = detailPosition(); if (position) warningPopup?.setLngLat([...position]); }} onZoom={() => { const current = ready(); const position = warningGroup()?.coordinates; if (current && position) { closeWarning(); current.map.easeTo({ center: [...position], zoom: Math.min(current.map.getMaxZoom(), current.map.getZoom() + 2), duration: 450 }); } }} />}>
          <WarningDetails item={warning()} dashboard={props.dashboard} onClose={closeWarning} onShip={props.onSelect} onBack={groupedWarnings().length > 1 ? () => setWarningId(null) : undefined} onLayout={() => { const position = detailPosition(); if (position) warningPopup?.setLngLat([...position]); }} />
        </Show>
      }>{place => <PortDetails place={place()} dashboard={props.dashboard} onClose={closeWarning} onShip={props.onSelect} onLayout={() => warningPopup?.setLngLat([...place().coordinates])} />}</Show>
    </Portal>}</Show>
    <div ref={container} class="map-gl" tabIndex={-1} role="group" aria-label="Ship map. Select a ship to inspect its route. City badges show anchored ships, not arrivals or relevance." />
    <Show when={popupHost()}>{host => <Portal mount={host()}><button class="popup-dismiss" aria-label="Close ship popup" onClick={props.onDismiss}>×</button><button class="popup-open" onClick={props.onOpen}><span class="reference">{props.selected?.reference}</span><strong>{props.selected?.vessel}</strong><span class="popup-eta">ETA {props.selected && new Date(props.selected.eta).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC</span><span class={`risk-badge ${props.selected?.risk}`}>{props.selected && riskLabel[props.selected.risk]}</span><span class="popup-brief">{props.selected && shipmentBrief(props.selected).text}</span><span class="popup-source">{props.selected && shipmentBrief(props.selected).source}</span><span class="popup-cta">Open voyage briefing →</span></button></Portal>}</Show>
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
    <MapLegend visible={visible()} onToggle={toggleLayer} />
    <Show when={ready()}>{runtime => <div class="gz-map-staging">
      <Index each={visible().ports ? ports() : []}>{port => <MapMarker runtime={runtime()} position={port().geometry.coordinates}>
        <button type="button" class={`gz-city ${port().properties.risk}`} data-port-id={port().properties.id} aria-haspopup="dialog" title={port().properties.label.replace('\n', ': ')} aria-label={`${port().properties.name} port details`} onClick={event => openPort(event, port().properties.id)}>
          <Show when={(port().properties.anchored ?? 0) > 0}><span class="gz-city-count">{port().properties.anchored}</span></Show>
          <span class="port-label city-name">{port().properties.name}</span>
          <Show when={props.selected?.destination === port().properties.id}><span class="gz-city-pill">{port().properties.name}</span></Show>
        </button>
      </MapMarker>}</Index>
      <Index each={visible().ships ? views() : []}>{ship => {
        const selected = (): boolean => props.selected?.id === ship().id;
        const status = (): string => statusLine(ship());
        return <MapMarker runtime={runtime()} position={ship().position}>
          <button type="button" class={`gz-ship ${ship().risk}`} classList={{ selected: selected() }} aria-label={`${ship().vessel}, ${status()}`} aria-pressed={selected()} title={`${ship().vessel} · ${status()}`} onClick={() => { clearDetails(); props.onSelect(ship().id); }}>
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
    <Show when={props.inspected && visible().diversions}><div class="alternative-map-caption">{props.inspected?.name} · indicative connection; revised ETA unconfirmed</div></Show>
    <Show when={failed()}><p class="map-fallback" role="status">The map could not be drawn. The fleet list retains every ship and ETA.</p></Show>
    <p class="gz-map-hint">Drag to pan · Scroll to zoom</p>
  </div>;
}
