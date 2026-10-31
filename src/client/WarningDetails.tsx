import { createMemo, For, onCleanup, onMount, Show } from 'solid-js';
import { ArrowRight, ExternalLink, TriangleAlert, X } from 'lucide-solid';
import type { Dashboard, IntelligenceItem } from '../shared';
import './warning-details.css';

const relevanceLabel = { route: 'Planned route', diversion: 'Potential diversion', context: 'Regional context' } as const;
const observed = (value: string) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

export function WarningDetails(props: Readonly<{
  item: IntelligenceItem | undefined; dashboard: Dashboard | null;
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
  const liveSource = createMemo(() => { const evidence = props.item?.evidence; return evidence?.source === 'live' ? evidence : null; });
  const ships = createMemo(() => {
    const reasons = props.item?.relevance ?? [];
    return (props.dashboard?.shipments ?? []).filter(ship => reasons.some(reason => reason.shipmentId === ship.id));
  });
  return <section ref={content} class="warning-dialog" role="dialog" aria-label={props.item?.evidence.title} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } }}>
      <Show when={props.item}>{item => <>
        <header><span class="warning-eyebrow"><TriangleAlert size={16} />MAP WARNING</span><button ref={closeButton} class="icon-button" aria-label="Close warning details" onClick={props.onClose}><X size={20} /></button></header>
        <div class="warning-body"><div class="warning-tags"><For each={[...new Set(item().relevance.map(reason => reason.kind))]}>{kind => <span>{relevanceLabel[kind]}</span>}</For><span>{item().evidence.source === 'live' ? 'Live report' : 'Simulated report'}</span></div>
          <h2>{item().evidence.title}</h2>
          <p class="warning-description">{item().evidence.detail}</p>
          <p class="warning-observed">Observed <time dateTime={item().evidence.observedAt}>{observed(item().evidence.observedAt)} UTC</time></p>
          <section class="warning-relevance"><h3>Why this is on your map</h3><For each={[...new Set(item().relevance.map(reason => reason.reason))]}>{reason => <p>{reason}</p>}</For></section>
          <Show when={ships().length}><section class="warning-ships"><h3>Related shipments</h3><p>Open a ship to inspect its current assessment and ETA.</p><For each={ships()}>{ship => <button onClick={() => { props.onClose(); props.onShip(ship.id); }}><span><strong>{ship.vessel}</strong><small>{ship.reference} · {[...new Set(item().relevance.filter(reason => reason.shipmentId === ship.id).map(reason => relevanceLabel[reason.kind]))].join(' · ')}</small></span><ArrowRight size={16} /></button>}</For></section></Show>
          <p class="warning-impact-note">A relevant report does not by itself confirm a delay or a change to the ship’s risk assessment.</p>
          <Show when={liveSource()} fallback={<p class="warning-observed">Source: simulated scenario</p>}>{source => <a class="warning-source" href={source().url} target="_blank" rel="noopener noreferrer">Read original report · {source().provider.toUpperCase()}<ExternalLink size={14} /></a>}</Show>
        </div>
      </>}</Show>
  </section>;
}
