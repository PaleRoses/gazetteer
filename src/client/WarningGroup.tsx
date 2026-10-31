import { For, onCleanup, onMount } from 'solid-js';
import { ArrowRight, TriangleAlert, X, ZoomIn } from 'lucide-solid';
import type { IntelligenceItem } from '../shared';

export function WarningGroup(props: Readonly<{ items: readonly IntelligenceItem[]; onSelect: (id: string) => void; onClose: () => void; onZoom: () => void; onLayout: () => void }>) {
  let content: HTMLElement | undefined;
  let close: HTMLButtonElement | undefined;
  onMount(() => {
    close?.focus({ preventScroll: true });
    const resize = new ResizeObserver(props.onLayout);
    if (content) resize.observe(content);
    onCleanup(() => resize.disconnect());
  });
  return <section ref={content} class="warning-dialog" role="dialog" aria-label={`${props.items.length} warnings in this area`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); props.onClose(); } }}>
    <header><span class="warning-eyebrow"><TriangleAlert size={16} />{props.items.length} WARNINGS</span><button ref={close} class="icon-button" aria-label="Close warning group" onClick={props.onClose}><X size={20} /></button></header>
    <div class="warning-body warning-group-body"><p>Nearby reports on your monitored routes. Counts are warnings, not unique incidents.</p><button class="warning-group-zoom" onClick={props.onZoom}><ZoomIn size={15} />Zoom in to separate</button>
      <For each={props.items}>{item => <button class="warning-group-item" onClick={() => props.onSelect(item.evidence.id)}><span><strong>{item.evidence.title}</strong><small>{item.evidence.source === 'live' ? item.evidence.provider.toUpperCase() : 'SIMULATED'} · {item.evidence.observedAt.slice(0, 10)}</small></span><ArrowRight size={16} /></button>}</For>
    </div>
  </section>;
}
