import { For, Show } from 'solid-js';
import { ArrowRight, Route, Ship } from 'lucide-solid';
import { corridorId } from '../routes';
import type { Dashboard, MonitoredRoute, Shipment } from '../shared';
import { riskLabel } from './brief';

export const routeName = (route: MonitoredRoute, dashboard: Dashboard): string => route.endpoints.map(id => dashboard.ports.find(p => p.id === id)?.name ?? id).join(' ↔ ');
export function RouteCard(props: { route: MonitoredRoute; dashboard: Dashboard; onOpen: (id: string) => void }) {
  return <button class="route-card" onClick={() => props.onOpen(props.route.id)}><div class="route-card-top"><Route size={18} /><span class={`risk-badge ${props.route.risk}`}>{riskLabel[props.route.risk]}</span></div><h2>{routeName(props.route, props.dashboard)}</h2><p>{props.route.shipmentIds.length} {props.route.shipmentIds.length === 1 ? 'shipment' : 'shipments'} · both directions</p><small class="route-risk-label">Highest shipment risk</small><span class="route-card-summary">{props.route.attention} needing attention<span>Open route <ArrowRight size={14} /></span></span></button>;
}
export function RouteDetails(props: { route: MonitoredRoute; dashboard: Dashboard; onVoyage: (id: string) => void }) {
  const members = () => props.dashboard.shipments.filter(s => props.route.shipmentIds.includes(s.id));
  const portName = (id: string) => props.dashboard.ports.find(p => p.id === id)?.name ?? id;
  const direction = (s: Shipment) => {
    const calls = [s.origin, ...s.via, s.destination];
    const i = calls.findIndex((from, i) => calls[i + 1] && corridorId(from, calls[i + 1]!) === props.route.id);
    return i < 0 ? '' : `${portName(calls[i]!)} → ${portName(calls[i + 1]!)}`;
  };
  return <aside class="detail-panel route-details" aria-label="Route monitoring details"><span class="section-kicker">SHARED CORRIDOR</span><h2>{routeName(props.route, props.dashboard)}</h2><p class="route-definition">A port-to-port leg shared by these voyages, in either direction. Paths are approximate; this is not a carrier service or official traffic lane.</p>
    <section class="route-health"><span class="section-kicker">HIGHEST SHIPMENT RISK</span><span class={`risk-badge ${props.route.risk}`}>{riskLabel[props.route.risk]}</span><p>{props.route.summary}</p><div class="route-metrics"><div><strong>{members().length}</strong><span>Shipments</span></div><div><strong>{props.route.attention}</strong><span>Need attention</span></div><div><strong>+{props.route.maxDelayHours}h</strong><span>Max arrival delay</span></div></div><small>Risk and delays describe member shipments, not a corridor-wide delay estimate.</small></section>
    <section class="detail-section"><h3>Endpoint monitoring</h3><For each={props.route.endpoints}>{id => { const status = () => props.dashboard.portStatus?.find(p => p.portId === id); return <article class="endpoint-status"><strong>{portName(id)}</strong><span>{status()?.bulletin ? `${status()?.risk} · ${new Date(status()!.bulletin!.at).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC` : 'No current port bulletin'}</span><Show when={status()?.bulletin}>{b => <p>{b().summary}</p>}</Show></article>; }}</For></section>
    <section class="detail-section"><h3><Ship size={16} /> Shipments using this route</h3><For each={members()}>{s => <button class="route-member" onClick={() => props.onVoyage(s.id)}><span><strong>{s.vessel}</strong><small>{s.reference} · {direction(s)}</small></span><span class={`risk-badge ${s.risk}`}>{riskLabel[s.risk]}</span><span class="route-member-eta">Final destination ETA · {new Date(s.eta).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC</span><span class="route-member-link">Open voyage <ArrowRight size={13} /></span></button>}</For></section>
  </aside>;
}
