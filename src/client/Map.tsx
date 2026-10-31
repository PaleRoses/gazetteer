import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show, untrack, type JSX } from 'solid-js';
import { Portal } from 'solid-js/web';
import type { GeoJSONSource, Map as MapLibreMap, Marker, Popup, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Dashboard, Diversion, MonitoredRoute, Port, Shipment } from '../core/types';
import type { LngLat } from '../core/routes';
import { boundsOf, graticule, portFeatures, routeLayers, vesselViews } from './map-model';
import { riskLabel, shipmentBrief } from './brief';
import { WarningDetails } from './WarningDetails';
import { WarningGroup } from './WarningGroup';
import { clusterWarnings } from './warning-clusters';
import { warningLabel, warningTone } from './warning-severity';
import { PortDetails } from './PortDetails';

type MapLibre = typeof import('maplibre-gl');
type Runtime = Readonly<{ lib: MapLibre; map: MapLibreMap }>;
type Selection = Readonly<{ dashboard: Dashboard | null; selected: Shipment | undefined; focusId: string | null; onSelect: (id: string) => void; onOpen: () => void; onDismiss: () => void; showPopup: boolean; inspected: Diversion | null; corridor?: MonitoredRoute; routeMode?: boolean; onRoute: (id: string) => void }>;
type Projection = 'mercator' | 'globe';
const COLOURS = { ocean: '#111315', land: '#1f211d', coast: '#3b3e37', grid: '#3b3e37', route: '#8cc3a1', corridor: '#e8e4d6', alternative: '#b9a7d6' } as const;
const RISK_COLOURS = { 'on-track': '#e8e4d6', watch: '#e0a03a', delayed: '#e5603f' } as const;
const PORT_COLOURS = { normal: '#e8e4d6', elevated: '#e0a03a', severe: '#e5603f', unreported: '#aaa99e' } as const;
const FRAME_PADDING = { top: 90, bottom: 75, left: 70, right: 70 } as const;
const WORLD: [[number, number], [number, number]] = [[-180, -58], [180, 76]];
const style = (origin: string): StyleSpecification => ({
  version: 8, projection: { type: 'mercator' },
  sources: { land: { type: 'geojson', data: `${origin}/geo/land.geojson` }, graticule: { type: 'geojson', data: graticule(30) } },
  layers: [
    { id: 'ocean', type: 'background', paint: { 'background-color': COLOURS.ocean } },
    { id: 'graticule', type: 'line', source: 'graticule', paint: { 'line-color': COLOURS.grid, 'line-width': 0.5, 'line-opacity': 0.12 } },
    { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': COLOURS.land } },
    { id: 'coast', type: 'line', source: 'land', paint: { 'line-color': COLOURS.coast, 'line-width': 0.7 } },
    { id: 'corridors', type: 'line', source: 'corridors', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': COLOURS.corridor, 'line-width': 5, 'line-opacity': 0.35 } },
    { id: 'corridor-hit', type: 'line', source: 'corridors', paint: { 'line-color': COLOURS.corridor, 'line-width': 24, 'line-opacity': 0.01 } },
    { id: 'alternative', type: 'line', source: 'alternative', paint: { 'line-color': COLOURS.alternative, 'line-width': 2, 'line-dasharray': [3, 3] } },
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
const element = (tag: string, className: string, text?: string): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function ShipmentMap(props: Selection) {
  let container: HTMLDivElement | undefined;
  const [ready, setReady] = createSignal<Runtime>();
  const [failed, setFailed] = createSignal(false);
  const [now, setNow] = createSignal(Date.now());
  const [projection, setProjection] = createSignal<Projection>('mercator');
  let framed: string | undefined;
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
  const [frameWidth, setFrameWidth] = createSignal(0);
  const [popupHost, setPopupHost] = createSignal<HTMLElement | undefined>();
  let popup: Popup | undefined;
  const views = createMemo(() => vesselViews(props.dashboard?.shipments ?? [], now()));
  const ports = createMemo(() => portFeatures(props.dashboard?.ports ?? [], props.dashboard?.portStatus, props.dashboard?.board));
  const clearDetails = (): void => { setWarningGroup(null); setWarningId(null); setPortPlace(null); };
  const tick = window.setInterval(() => setNow(Date.now()), 4_000);
  onCleanup(() => window.clearInterval(tick));
  onMount(() => {
    const host = container;
    if (!host) return;
    let disposed = false;
    let created: MapLibreMap | undefined;
    const resize = new ResizeObserver(() => { created?.resize(); setFrameWidth(host.clientWidth); });
    resize.observe(host);
    onCleanup(() => { resize.disconnect(); popup?.remove(); warningPopup?.remove(); disposed = true; created?.remove(); });
    void import('maplibre-gl').then(lib => {
      if (disposed) return;
      lib.setWorkerUrl(workerUrl);
      const base = style(window.location.origin);
      const map = new lib.Map({ container: host, style: { ...base, sources: { ...base.sources, lanes: { type: 'geojson', data: empty }, sailed: { type: 'geojson', data: empty }, ahead: { type: 'geojson', data: empty }, corridors: { type: 'geojson', data: empty }, alternative: { type: 'geojson', data: empty } } }, center: [15, 18], zoom: 0.8, minZoom: 0, maxZoom: 9, attributionControl: false, dragRotate: false, pitchWithRotate: false });
      created = map;
      const updatePortLabels = () => host.classList.toggle('port-labels-visible', map.getZoom() >= 4);
      updatePortLabels();
      map.on('zoom', updatePortLabels);
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.AttributionControl({ compact: true, customAttribution: 'Natural Earth · SeaRoute lanes · positions simulated' }), 'bottom-right');
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'bottom-right');
      map.on('load', () => {
        map.on('click', 'corridor-hit', event => { const id = event.features?.[0]?.properties?.id; if (typeof id === 'string') props.onRoute(id); });
        map.on('mouseenter', 'corridor-hit', () => { map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', 'corridor-hit', () => { map.getCanvas().style.cursor = ''; });
        if (!disposed) { map.fitBounds(WORLD, { padding: 25, duration: 0 }); setReady({ lib, map }); }
      });
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
    if (!current) return;
    const corridors = props.corridor ? [props.corridor] : props.routeMode ? props.dashboard?.routes ?? [] : [];
    setFeatures(current.map, 'corridors', { type: 'FeatureCollection', features: corridors.filter(r => r.path.length > 1).map(r => ({ type: 'Feature', properties: { id: r.id }, geometry: { type: 'LineString', coordinates: r.path.map(p => [...p]) } })) });
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
    else current.map.fitBounds(WORLD, { padding: 25, duration: 600 });
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
        const node = element('button', `news-marker warning-${warningTone(group.severity)}${multi ? ' news-cluster' : ''}`, multi ? String(group.items.length) : '!');
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
  return <div class="map-canvas operating-map">
    <Show keyed when={warningHost()}>{host => <Portal mount={host}>
      <Show when={portPlace()} fallback={
        <Show when={warning()} fallback={<WarningGroup items={groupedWarnings()} onClose={closeWarning} onSelect={setWarningId} onLayout={() => { const position = detailPosition(); if (position) warningPopup?.setLngLat([...position]); }} onZoom={() => { const current = ready(); const position = warningGroup()?.coordinates; if (current && position) { closeWarning(); current.map.easeTo({ center: [...position], zoom: Math.min(current.map.getMaxZoom(), current.map.getZoom() + 2), duration: 450 }); } }} />}>
          <WarningDetails item={warning()} dashboard={props.dashboard} onClose={closeWarning} onShip={props.onSelect} onBack={groupedWarnings().length > 1 ? () => setWarningId(null) : undefined} onLayout={() => { const position = detailPosition(); if (position) warningPopup?.setLngLat([...position]); }} />
        </Show>
      }>{place => <PortDetails place={place()} dashboard={props.dashboard} onClose={closeWarning} onShip={props.onSelect} onLayout={() => warningPopup?.setLngLat([...place().coordinates])} />}</Show>
    </Portal>}</Show>
    <div ref={container} class="map-gl" tabIndex={-1} role="group" aria-label="Ship map. Select a ship to inspect its route. City badges show anchored ships, not arrivals or relevance." />
    <Show when={popupHost()}>{host => <Portal mount={host()}><button class="popup-dismiss" aria-label="Close ship popup" onClick={props.onDismiss}>×</button><button class="popup-open" onClick={props.onOpen}><span class="reference">{props.selected?.reference}</span><strong>{props.selected?.vessel}</strong><span class="popup-eta">ETA {props.selected && new Date(props.selected.eta).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC</span><span class={`risk-badge ${props.selected?.risk}`}>{props.selected && riskLabel[props.selected.risk]}</span><span class="popup-brief">{props.selected && shipmentBrief(props.selected).text}</span><span class="popup-source">{props.selected && shipmentBrief(props.selected).source}</span><span class="popup-cta">Open voyage briefing →</span></button></Portal>}</Show>
    <div class="map-projection" role="group" aria-label="Map projection" style={{ position: 'absolute', top: '18px', left: '18px', display: 'flex', gap: '4px', 'z-index': '3' }}><button type="button" aria-pressed={projection() === 'mercator'} onClick={() => setProjection('mercator')}>Map</button><button type="button" aria-pressed={projection() === 'globe'} onClick={() => setProjection('globe')}>Globe</button></div>
    <button type="button" class="map-whole-world" style={{ position: 'absolute', top: '18px', right: '18px', 'z-index': '3' }} onClick={() => ready()?.map.fitBounds(WORLD, { padding: 25, duration: 700 })}>Whole world</button>
    <Show when={ready()}>{runtime => <div style={{ display: 'none' }}>
      <For each={ports().features}>{port => <MapMarker runtime={runtime()} position={port.geometry.coordinates}><button type="button" class="city-marker" data-port-id={port.properties.id} aria-haspopup="dialog" title={port.properties.label.replace('\n', ': ')} aria-label={`${port.properties.name} port details`} onClick={event => openPort(event, port.properties.id)} style={{ position: 'relative', display: 'block', padding: '0', cursor: 'pointer', width: '10px', height: '10px', border: `1px solid ${PORT_COLOURS[port.properties.risk]}`, background: port.properties.risk === 'unreported' ? '#111315' : PORT_COLOURS[port.properties.risk] }}><span class="port-label city-name">{port.properties.name}</span><Show when={port.properties.anchored !== null}><span class="city-count" style={{ position: 'absolute', left: '12px', top: '-9px', 'border-radius': '50%', background: PORT_COLOURS[port.properties.risk], color: '#111315', 'font-size': '10px', 'font-weight': '700', 'min-width': '15px', height: '15px', 'text-align': 'center', 'line-height': '15px' }}>{port.properties.anchored}</span></Show></button></MapMarker>}</For>
      <For each={views()}>{ship => <MapMarker runtime={runtime()} position={ship.position}><button type="button" class={`pixel-vessel ${ship.risk}${props.selected?.id === ship.id ? ' selected' : ''}`} aria-label={`${ship.vessel}, ${riskLabel[ship.risk]}`} aria-pressed={props.selected?.id === ship.id} title={`${ship.vessel} · ${riskLabel[ship.risk]}`} onClick={() => { clearDetails(); props.onSelect(ship.id); }} style={{ position: 'relative', padding: '5px', color: RISK_COLOURS[ship.risk], background: 'transparent', border: props.selected?.id === ship.id ? '1px solid #8cc3a1' : '1px solid transparent' }}>
        <svg class="pixel-ship" width="30" height="20" viewBox="0 0 15 10" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M6 0h1v2h3v3h3v1h2v2h-2v1H2V8H0V6h3V3h3zm-1 4v1h2V4zm3 0v1h1V4z" /></svg>
        <Show when={ship.risk !== 'on-track'}><span class="pixel-vessel-alert" aria-hidden="true" style={{ position: 'absolute', top: '-7px', right: '-7px', color: RISK_COLOURS[ship.risk] }}>{ship.risk === 'watch' ? '▲' : '!'}</span></Show>
        <Show when={props.selected?.id === ship.id}><span class="pixel-vessel-name" style={{ position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)', color: '#e8e4d6', 'white-space': 'nowrap', 'font-size': '11px' }}>{ship.vessel}</span></Show>
      </button></MapMarker>}</For>
    </div>}</Show>
    <Show when={props.inspected}><div class="alternative-map-caption">{props.inspected?.name} · indicative connection; revised ETA unconfirmed</div></Show>
    <Show when={failed()}><p class="map-fallback" role="status">The map could not be drawn. The fleet list retains every ship and ETA.</p></Show>
    <p class="map-interaction-hint" style={{ position: 'absolute', bottom: '18px', width: '100%', 'text-align': 'center', color: '#aaa99e', 'font-size': '11px', 'pointer-events': 'none' }}>Drag to pan · Scroll to zoom</p>
  </div>;
}
const backdrop = new URL('./world-coastline.svg', import.meta.url).href;
export function MapBackdrop() { return <div class="map-canvas"><svg class="world-map" viewBox="0 30 1000 420" aria-hidden="true"><image href={backdrop} width="1000" height="500" /></svg></div>; }
