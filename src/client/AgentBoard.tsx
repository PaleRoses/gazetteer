import { createMemo, createSignal, For, Show } from 'solid-js';
import { Activity, Anchor, ArrowRight, Radio, Ship } from 'lucide-solid';
import type { BoardMessage } from '../board';
import type { Dashboard, Port } from '../shared';
import { boardAuthor, boardExplanation, boardKinds, boardPort, boardRisk, boardTime, filterBoard, readableBoardSummary } from './board-view';
import './agent-board.css';

function MessageCard(props: Readonly<{ message: BoardMessage; ports: readonly Port[] }>) {
  const message = () => props.message;
  const tag = () => { const item = message(); return item.kind === 'ship.assessment' ? boardRisk[item.risk] : item.kind === 'port.bulletin' ? boardRisk[item.risk] : boardKinds[item.kind]; };
  const tone = () => { const item = message(); return (item.kind === 'ship.assessment' || item.kind === 'port.bulletin') ? item.risk : 'neutral'; };
  const provenance = () => {
    const item = message();
    if (item.kind === 'ship.assessment') return item.method === 'ai-assessed' ? `AI assessment · ${Math.round(item.confidence * 100)}% confidence` : item.method === 'deterministic-fallback' ? 'Rule-based fallback' : 'Rule-based assessment';
    if (item.kind === 'ship.observation') return `Position source: ${item.provider}`;
    return 'Agent report';
  };
  return <li class="agent-message"><div class={`agent-message-icon ${tone()}`}><Show when={message().author.role === 'port'} fallback={<Ship size={18} />}><Anchor size={18} /></Show></div><article>
    <header><div><strong>{boardAuthor(message(), props.ports)}</strong><span>{message().author.role === 'port' ? 'Port agent' : 'Ship agent'} · {boardKinds[message().kind]}</span></div><time dateTime={message().at}>{boardTime(message().at)}</time></header>
    <span class={`agent-message-tag ${tone()}`}>{tag()}</span>
    <p class="agent-message-explanation">{boardExplanation(message(), props.ports)}</p>
    <Show when={message().kind === 'ship.assessment' || message().kind === 'port.bulletin'}><p class="agent-message-summary">{readableBoardSummary(message(), props.ports)}</p></Show>
    <footer>{provenance()}</footer>
    <details><summary>Message details</summary><dl><dt>Original message</dt><dd>{message().summary}</dd><dt>Message ID</dt><dd>{message().id}</dd></dl><pre>{JSON.stringify(message(), null, 2)}</pre></details>
  </article></li>;
}

export function AgentBoard(props: Readonly<{ dashboard: Dashboard | null; connection: string }>) {
  const [kind, setKind] = createSignal('all');
  const [entity, setEntity] = createSignal('all');
  const [query, setQuery] = createSignal('');
  const ports = () => props.dashboard?.ports ?? [];
  const messages = createMemo(() => filterBoard(props.dashboard?.board ?? [], kind(), entity(), query(), ports()));
  const reset = () => { setKind('all'); setEntity('all'); setQuery(''); };
  return <main class="agent-board-page" aria-label="Agent activity">
      <header class="agent-board-header"><div><span class="section-kicker">THE AGENT MESSAGE BOARD</span><h1>Agent activity</h1><p>Messages exchanged by your ship and port agents: observations, risk assessments, arrival updates and port bulletins.</p></div></header>
      <div class="agent-board-status"><span><Radio size={13} />{props.connection === 'live' ? 'Receiving live updates' : props.connection === 'polling' ? 'Checking for updates every 5 seconds' : 'Connecting to updates'}</span><span>Latest {props.dashboard?.board?.length ?? 0} messages · All times UTC</span></div>
      <div class="agent-board-filters"><label>Search activity<input type="search" placeholder="Ship, port or message" value={query()} onInput={event => setQuery(event.currentTarget.value)} /></label><label>Message type<select value={kind()} onChange={event => setKind(event.currentTarget.value)}><option value="all">All messages</option><For each={Object.entries(boardKinds)}>{([value, label]) => <option value={value}>{label}</option>}</For></select></label><label>Ship or port<select value={entity()} onChange={event => setEntity(event.currentTarget.value)}><option value="all">All ships and ports</option><optgroup label="Ships"><For each={props.dashboard?.shipments ?? []}>{ship => <option value={`ship:${ship.id}`}>{ship.vessel}</option>}</For></optgroup><optgroup label="Ports"><For each={ports()}>{port => <option value={`port:${port.id}`}>{boardPort(port.id, ports())}</option>}</For></optgroup></select></label></div>
      <div class="agent-board-content"><p class="agent-board-context">Vessel positions are simulated. A board message reports an agent’s observation or assessment; it does not confirm a carrier action.</p>
        <Show when={props.dashboard?.board !== undefined} fallback={<div class="agent-board-empty" role="status"><Radio size={26} /><h3>Waiting for the message board</h3><p>Messages appear here when board history is available. The feed will update automatically.</p></div>}>
          <Show when={messages().length > 0} fallback={<div class="agent-board-empty"><Activity size={28} /><h3>{props.dashboard?.board?.length ? 'No matching messages' : 'No agent messages yet'}</h3><p>{props.dashboard?.board?.length ? 'Try another ship, port, message type or search.' : 'Ship observations, port bulletins and arrival updates will appear here as agents share them.'}</p><Show when={kind() !== 'all' || entity() !== 'all' || query()}><button onClick={reset}>Clear filters<ArrowRight size={14} /></button></Show></div>}><div class="agent-board-count" role="status">{messages().length} messages · Newest first</div><ol class="agent-message-list"><For each={messages()}>{message => <MessageCard message={message} ports={ports()} />}</For></ol></Show>
        </Show>
      </div>
  </main>;
}
