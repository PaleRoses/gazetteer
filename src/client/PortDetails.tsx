import { createMemo, For, onCleanup, onMount, Show } from 'solid-js';
import { Anchor, ArrowRight, X } from 'lucide-solid';
import type { Dashboard, Diversion, Port } from '../core/types';
import { boardRisk, boardTime } from './board-view';
import { riskLabel } from './brief';
import { arrivalStatus, incomingShips } from './port-arrivals';
import { RiskBadge } from './presentation';
import './port-details.css';

export function PortDetails(props: Readonly<{
  place: Port | Diversion; dashboard: Dashboard | null;
  onClose: () => void; onShip: (id: string) => void; onLayout: () => void;
}>) {
  let content: HTMLElement | undefined;
  let closeButton: HTMLButtonElement | undefined;
  onMount(() => {
    closeButton?.focus({ preventScroll: true });
    const resize = new ResizeObserver(() => props.onLayout());
    if (content) resize.observe(content);
    onCleanup(() => resize.disconnect());
  });
  const alternative = createMemo(() => 'replaces' in props.place ? props.place : undefined);
  const status = createMemo(() => props.dashboard?.portStatus?.find(status => status.portId === props.place.id));
  const bulletin = () => status()?.bulletin;
  const arrivals = createMemo(() => 'country' in props.place ? incomingShips(props.dashboard?.shipments ?? [], props.place.id) : []);
  const candidates = createMemo(() => (props.dashboard?.shipments ?? []).filter(ship => ship.id === alternative()?.shipmentId));
  return <section ref={content} class="warning-dialog port-popover" role="dialog" aria-label={`${props.place.name} port details`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } }}>
    <header><span class="warning-eyebrow"><Anchor size={16} />{alternative() ? 'ALTERNATIVE PORT' : 'PORT OVERVIEW'}</span><button ref={closeButton} class="icon-button" aria-label="Close port details" onClick={props.onClose}><X size={20} /></button></header>
    <div class="warning-body"><h2>{props.place.name}</h2><Show when={'country' in props.place ? props.place.country : undefined}>{country => <p class="port-country">{country()}</p>}</Show>
      <Show when={!alternative()}><span class={`port-condition ${status()?.risk ?? 'unreported'}`}>Port status: {status() ? boardRisk[status()!.risk] : 'Unreported'}</span></Show>
      <Show when={alternative()} fallback={<details class="port-bulletin"><summary>Port bulletin &amp; conditions</summary><Show when={bulletin()} fallback={<p class="port-no-bulletin">No port bulletin available yet. Current conditions are unconfirmed.</p>}>{report => <><p class="warning-description">{report().summary}</p><dl class="port-popover-metrics"><div><dt>Vessels at anchor</dt><dd>{report().anchored}</dd></div><div><dt>Arrivals within 48h</dt><dd>{report().arrivals48h}</dd></div></dl><p class="warning-observed">Port agent bulletin · <time dateTime={report().at}>{boardTime(report().at)}</time></p></>}</Show></details>}>{option => <><span class="port-condition alternative">Potential diversion</span><p class="warning-description">{option().reason}</p><p class="port-no-bulletin">{option().constraint}</p><p class="warning-observed">Capacity and revised ETA are unconfirmed.</p></>}</Show>
      <Show when={!alternative()} fallback={<section class="warning-ships"><h3>Diversion candidates · {candidates().length}</h3><For each={candidates()}>{ship => <button onClick={() => { props.onClose(); props.onShip(ship.id); }}><span><strong>{ship.vessel}</strong><small>{riskLabel[ship.risk]} · Capacity and ETA unconfirmed</small></span><ArrowRight size={16} /></button>}</For></section>}>
        <section class="warning-ships port-arrivals"><h3>Incoming ships · {arrivals().length}</h3><Show when={arrivals().length} fallback={<p>No incoming ships in this view.</p>}><For each={arrivals()}>{arrival => <button onClick={() => { props.onClose(); props.onShip(arrival.ship.id); }}><span><strong>{arrival.ship.vessel}</strong><small>{arrivalStatus(arrival.ship)} · {arrival.transit ? 'Transit call' : 'Destination arrival'}</small><small>ETA {boardTime(arrival.eta)}{Date.parse(arrival.eta) < Date.parse(props.dashboard?.updatedAt ?? '') ? ' · Overdue' : ''}</small><RiskBadge risk={arrival.ship.risk} /></span><ArrowRight size={16} /></button>}</For></Show><p class="port-arrival-note">{arrivals().some(a => !a.ship.voyage) ? 'Demo voyage status and estimated arrival times.' : 'Operator-reported status and estimated arrival times.'}</p></section>
      </Show>
    </div>
  </section>;
}
