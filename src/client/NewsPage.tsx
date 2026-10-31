import { createMemo, createSignal, For, Show } from 'solid-js';
import { Newspaper } from 'lucide-solid';
import type { Dashboard, Diversion } from '../shared';
import { IntelligencePanel } from './Intelligence';
import { routeName } from './Routes';

export function NewsPage(props: Readonly<{ dashboard: Dashboard | null; onInspect: (option: Diversion) => void }>) {
  const [scope, setScope] = createSignal('all');
  const shipment = createMemo(() => props.dashboard?.shipments.find(ship => `ship:${ship.id}` === scope()));
  const route = createMemo(() => props.dashboard?.routes?.find(item => `route:${item.id}` === scope()));
  return <main class="news-page"><header class="news-page-header"><span class="section-kicker">REPORTS & REGIONAL CONTEXT</span><h1><Newspaper size={26} />News</h1><p>External reports relevant to your routes and potential diversions. Simulated scenario notices are labelled separately.</p><label>Coverage<select value={scope()} onChange={event => setScope(event.currentTarget.value)}><option value="all">All shipments and routes</option><optgroup label="Ships"><For each={props.dashboard?.shipments ?? []}>{ship => <option value={`ship:${ship.id}`}>{ship.vessel}</option>}</For></optgroup><optgroup label="Routes"><For each={props.dashboard?.routes ?? []}>{item => <option value={`route:${item.id}`}>{routeName(item, props.dashboard!)}</option>}</For></optgroup></select></label></header>
    <Show when={props.dashboard} fallback={<p class="news-page-loading" role="status">Loading news coverage…</p>}>{dashboard => <IntelligencePanel hideHeading dashboard={dashboard()} shipment={shipment()} routeName={route() ? routeName(route()!, dashboard()) : undefined} coverage={route()?.intelligence} inspected={null} onInspect={option => { if (option) props.onInspect(option); }} />}</Show>
  </main>;
}
