import { createMemo, For, onCleanup, onMount, Show } from 'solid-js';
import { Anchor, ArrowRight, X } from 'lucide-solid';
import type { Dashboard, Diversion, Port, Shipment } from '../core/types';
import { boardRisk, boardTime } from './board-view';
import { riskLabel } from './brief';
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
  const bulletin = createMemo(() => props.dashboard?.portStatus?.find(status => status.portId === props.place.id)?.bulletin);
  const ships = createMemo(() => (props.dashboard?.shipments ?? []).filter(ship => alternative() ? ship.id === alternative()!.shipmentId : ship.origin === props.place.id || ship.destination === props.place.id || ship.via.some(id => id === props.place.id)));
  const role = (ship: Shipment): string => alternative() ? 'Diversion candidate' : ship.destination === props.place.id ? 'Destination' : ship.via.some(id => id === props.place.id) ? 'Via port' : 'Departed from';
  return <section ref={content} class="warning-dialog port-popover" role="dialog" aria-label={`${props.place.name} port details`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } }}>
    <header><span class="warning-eyebrow"><Anchor size={16} />{alternative() ? 'ALTERNATIVE PORT' : 'PORT OVERVIEW'}</span><button ref={closeButton} class="icon-button" aria-label="Close port details" onClick={props.onClose}><X size={20} /></button></header>
    <div class="warning-body"><h2>{props.place.name}</h2><Show when={'country' in props.place ? props.place.country : undefined}>{country => <p class="port-country">{country()}</p>}</Show>
      <Show when={alternative()} fallback={<Show when={bulletin()} fallback={<p class="port-no-bulletin">No port bulletin available yet. Current conditions are unconfirmed.</p>}>{report => <><span class={`port-condition ${report().risk}`}>{boardRisk[report().risk]}</span><p class="warning-description">{report().summary}</p><dl class="port-popover-metrics"><div><dt>Vessels at anchor</dt><dd>{report().anchored}</dd></div><div><dt>Arrivals within 48h</dt><dd>{report().arrivals48h}</dd></div></dl><p class="warning-observed">Port agent bulletin · <time dateTime={report().at}>{boardTime(report().at)}</time></p></>}</Show>}>{option => <><span class="port-condition alternative">Potential diversion</span><p class="warning-description">{option().reason}</p><p class="port-no-bulletin">{option().constraint}</p><p class="warning-observed">Capacity and revised ETA are unconfirmed.</p></>}</Show>
      <section class="warning-ships"><h3>Related shipments · {ships().length}</h3><Show when={ships().length} fallback={<p>No shipments in this view call at this port.</p>}><For each={ships()}>{ship => <button onClick={() => { props.onClose(); props.onShip(ship.id); }}><span><strong>{ship.vessel}</strong><small>{ship.reference} · {role(ship)} · {riskLabel[ship.risk]}</small><Show when={ship.destination === props.place.id}><small>ETA {boardTime(ship.eta)}</small></Show></span><ArrowRight size={16} /></button>}</For></Show></section>
    </div>
  </section>;
}
