import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { shipmentBrief, riskLabel } from './brief';
import type { GeoJSONSource, Popup, Map as MapLibreMap, Marker, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { Dashboard, Diversion, Shipment } from '../shared';
import { boundsOf, graticule, routeLayers, vesselViews, type VesselView } from './map-model';

type MapLibre = typeof import('maplibre-gl');
type Selection = Readonly<{ dashboard: Dashboard | null; selected: Shipment | undefined; focusId: string | null; onSelect: (id: string) => void; onOpen: () => void; onDismiss: () => void; inspected: Diversion | null; showPopup: boolean }>;

const COLOURS = { ocean: '#d6e6f2', land: '#f5f3ea', coast: '#8fb0c9', grid: '#9ebdd3', lane: '#5f87ad', route: '#1f5a9e' } as const;
const TICK_MS = 4_000;
const FRAME_PADDING = { top: 70, bottom: 150, left: 60, right: 110 } as const;
const OCEANS: readonly (readonly [string, number, number])[] = [['ATLANTIC OCEAN', -35, 25], ['PACIFIC OCEAN', -150, 10], ['PACIFIC OCEAN', 175, 5], ['INDIAN OCEAN', 78, -22]];
const RISK_TEXT = { 'on-track': 'low risk', watch: 'moderate risk', delayed: 'high risk' } as const;

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
  for (const id of ['lanes', 'sailed', 'ahead', 'alternative']) map.addSource(id, { type: 'geojson', data: emptyLines });
  map.addLayer({ id: 'alternative', type: 'line', source: 'alternative', paint: { 'line-color': '#8b5a9b', 'line-width': 2, 'line-dasharray': [2, 3] } });
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

export function ShipmentMap({ dashboard, selected, focusId, onSelect, onOpen, onDismiss, inspected, showPopup }: Selection) {
  const [popupHost, setPopupHost] = useState<HTMLElement | null>(null);
  const popup = useRef<Popup | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState<Readonly<{ lib: MapLibre; map: MapLibreMap }> | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const markers = useRef(new Map<string, Marker>());
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const inspectedFrame = useRef<string | null>(null);
  const fleetFramed = useRef(false);
  const framed = useRef<string | undefined>(undefined);

  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), TICK_MS); return () => window.clearInterval(timer); }, []);

  useEffect(() => {
    const host = container.current;
    if (!host) return;
    let disposed = false;
    let created: MapLibreMap | undefined;
    const trackedMarkers = markers.current;
    void import('maplibre-gl').then(module => {
      if (disposed) return;
      const lib: MapLibre = 'default' in module ? (module as unknown as { default: MapLibre }).default : module;
      lib.setWorkerUrl(new URL(workerUrl, window.location.href).href);
      const map = new lib.Map({
        container: host, style: style(window.location.origin), center: [30, 24], zoom: 1.15, minZoom: -0.5, maxZoom: 7,
        attributionControl: false, dragRotate: false, pitchWithRotate: false, cooperativeGestures: false,
      });
      created = map;
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.AttributionControl({ compact: true, customAttribution: 'Land: Natural Earth (public domain) · Sea lanes: Eurostat SeaRoute network · Positions interpolated from schedule (simulated)' }), 'bottom-right');
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
      OCEANS.forEach(([name, lon, lat]) => new lib.Marker({ element: element('span', 'ocean-label', name), anchor: 'center' }).setLngLat([lon, lat]).addTo(map));
      map.on('load', () => { addRouteLayers(map); if (!disposed) setReady({ lib, map }); });
      map.on('error', event => { if (!disposed && (event as { sourceId?: string }).sourceId === 'land') setFailed(true); });
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => { disposed = true; trackedMarkers.forEach(marker => marker.remove()); trackedMarkers.clear(); created?.remove(); setReady(null); };
  }, []);

  const views = useMemo(() => vesselViews(dashboard?.shipments ?? [], now), [dashboard, now]);
  const selectedId = selected?.id;

  useEffect(() => {
    if (!ready) return;
    const { lib, map } = ready;
    const layers = routeLayers(views, selectedId);
    setLines(map, 'lanes', layers.lanes); setLines(map, 'sailed', layers.sailed); setLines(map, 'ahead', layers.ahead);
    const known = markers.current;
    const live = new Set(views.map(view => view.id));
    known.forEach((marker, id) => { if (!live.has(id) && !id.includes(':')) { marker.remove(); known.delete(id); } });
    views.forEach(view => {
      const existing = known.get(view.id);
      const marker = existing ?? new lib.Marker({ element: vesselElement(id => onSelectRef.current(id), view), anchor: 'center' }).setLngLat([...view.position]).addTo(map);
      if (!existing) known.set(view.id, marker);
      marker.setLngLat([...view.position]);
      decorate(marker.getElement(), view, view.id === selectedId);
    });
  }, [ready, views, selectedId]);

  useEffect(() => {
    if (!ready || !dashboard) return;
    const { lib, map } = ready;
    dashboard.ports.forEach(port => {
      const key = `port:${port.id}`;
      if (markers.current.has(key)) return;
      const node = element('div', 'port-marker');
      node.append(element('span', 'port-dot'), element('span', 'port-label', port.name));
      markers.current.set(key, new lib.Marker({ element: node, anchor: 'left', offset: [-4, 0] }).setLngLat([...port.coordinates] as [number, number]).addTo(map));
    });
  }, [ready, dashboard]);

  useEffect(() => {
    if (ready && views.length && !fleetFramed.current && !focusId) {
      fleetFramed.current = true;
      ready.map.fitBounds([[-180, -50], [180, 65]], { padding: 45, duration: 0, maxZoom: 1.15 });
    }
    if (!focusId) framed.current = undefined;
    if (!ready || !focusId || framed.current === focusId) return;
    const view = views.find(item => item.id === focusId);
    const bounds = view && boundsOf(view.route);
    if (!bounds) return;
    framed.current = focusId;
    ready.map.fitBounds([[bounds[0], bounds[1]], [bounds[2], bounds[3]]], { padding: FRAME_PADDING, maxZoom: 4.2, duration: 900 });
  }, [ready, focusId, views]);

  useEffect(() => {
    if (!ready || !container.current) return;
    const observer = new ResizeObserver(() => ready.map.resize());
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [ready]);

  useEffect(() => {
    if (!ready || !selectedId || !showPopup) { setPopupHost(null); return; }
    const host = document.createElement('div');
    const card = new ready.lib.Popup({ closeButton: false, closeOnClick: false, focusAfterOpen: false, offset: 22, maxWidth: '290px', className: 'shipment-popup' });
    popup.current = card;
    setPopupHost(host);
    card.setDOMContent(host);
    return () => { card.remove(); popup.current = null; };
  }, [ready, selectedId, showPopup]);

  useEffect(() => {
    const view = views.find(view => view.id === selectedId);
    if (ready && view && popup.current) { popup.current.setLngLat([...view.position]); if (!popup.current.isOpen()) popup.current.addTo(ready.map); }
  }, [ready, selectedId, views, showPopup]);

  useEffect(() => {
    if (!ready) return;
    const { map, lib } = ready;
    const extra: Marker[] = [];
    const alternatives = (dashboard?.intelligence?.diversions ?? []).filter(option => !selectedId || option.shipmentId === selectedId);
    const seen = new Set<string>();
    alternatives.forEach(option => {
      if (seen.has(option.name)) return;
      seen.add(option.name);
      const node = element('div', 'alternative-port');
      node.append(element('span', 'alternative-dot'), element('span', '', option.name));
      node.title = 'Potential diversion · carrier confirmation required';
      extra.push(new lib.Marker({ element: node, anchor: 'left' }).setLngLat([...option.coordinates]).addTo(map));
    });
    (dashboard?.intelligence?.items ?? []).filter(item => item.coordinates && item.relevance.some(reason => !selectedId || reason.shipmentId === selectedId)).forEach(item => {
      const node = element('button', 'news-marker', '!') as HTMLButtonElement;
      node.type = 'button'; node.setAttribute('aria-label', item.evidence.title); node.title = item.evidence.title;
      node.addEventListener('click', () => { const id = item.relevance[0]?.shipmentId; if (id) onSelectRef.current(id); });
      extra.push(new lib.Marker({ element: node }).setLngLat([...item.coordinates!] as [number, number]).addTo(map));
    });
    return () => extra.forEach(marker => marker.remove());
  }, [ready, dashboard?.intelligence, selectedId]);

  useEffect(() => {
    if (!ready) return;
    const port = dashboard?.ports.find(port => port.id === inspected?.replaces);
    setLines(ready.map, 'alternative', inspected && port ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[...port.coordinates], [...inspected.coordinates]] } }] } : emptyLines);
    if (!inspected) inspectedFrame.current = null;
    if (inspected && port && inspectedFrame.current !== inspected.id) {
      inspectedFrame.current = inspected.id;
      ready.map.fitBounds([[Math.min(port.coordinates[0], inspected.coordinates[0]), Math.min(port.coordinates[1], inspected.coordinates[1])], [Math.max(port.coordinates[0], inspected.coordinates[0]), Math.max(port.coordinates[1], inspected.coordinates[1])]], { padding: 100, maxZoom: 5, duration: 600 });
    }
  }, [ready, inspected, dashboard?.ports]);

  return <div className="map-canvas">
    <div ref={container} className="map-gl" role="group" aria-label="Shipment map. Select a vessel with the markers or the shipment list." />
    {selected && showPopup && (popupHost ? createPortal(<div className="vessel-popup-card"><button className="popup-dismiss" onClick={onDismiss} aria-label="Close ship popup">×</button><button className="popup-open" onClick={onOpen}><span className="section-kicker">{selected.reference}</span><strong>{selected.vessel}</strong><span className="popup-eta">ETA {new Date(selected.eta).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</span><span className={`risk-badge ${selected.risk}`}>{riskLabel[selected.risk]}</span><span className="popup-brief">{shipmentBrief(selected).text}</span><span className="popup-source">{shipmentBrief(selected).source}</span><span className="popup-cta">Open voyage & news →</span></button></div>, popupHost) : failed && <button className="map-fallback-open" onClick={onOpen}>Open {selected.vessel} · voyage & news →</button>)}
    {inspected && <p className="alternative-map-caption">{inspected.name} · indicative port connection, not a navigable route</p>}
    {failed && <p className="map-fallback" role="status">The map could not be drawn. The shipment list still shows every route and ETA.</p>}
    <div className="map-legend" aria-hidden="true"><span><i className="legend-dot on-track" />Low</span><span><i className="legend-dot watch" />Moderate</span><span><i className="legend-dot delayed" />High</span></div>
  </div>;
}

const backdrop = new URL('./world-coastline.svg', import.meta.url).href;
export function MapBackdrop() {
  return <div className="map-canvas"><svg className="world-map" viewBox="0 30 1000 420" aria-hidden="true"><image href={backdrop} width="1000" height="500" /></svg></div>;
}
