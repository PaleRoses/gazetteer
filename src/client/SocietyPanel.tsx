import { createMemo, For, Show, type JSX } from 'solid-js';
import { Anchor, ArrowRight, MessageSquare, Ship } from 'lucide-solid';
import { concerns } from '../core/board';
import type { BoardMessage, PortRisk, ShipAssessment, ShipObservation } from '../core/board';
import type { Dashboard } from '../core/types';
import { resolveBoardCitations, type Citation } from './citations';
import { actorName, boardAnchor } from './ActorLine';
import { boardKinds } from './board-view';
import { date, EvidenceCard, portName, RiskBadge, time } from './presentation';

const methodLabel: Readonly<Record<ShipAssessment['method'], string>> = {
  'ai-assessed': 'AI assessment', 'deterministic-fallback': 'Rule-based fallback', deterministic: 'Deterministic model', 'rule-based': 'Rule-based assessment',
};
const signalLabel: Readonly<Record<ShipObservation['signals'][number], string>> = {
  'off-route': 'Off route', 'slow-steaming': 'Slow steaming', 'stationary-outside-port': 'Stationary outside port', 'ais-dark': 'AIS gap',
};
const portRiskOrder: Readonly<Record<PortRisk, number>> = { severe: 0, elevated: 1, normal: 2 };

function BoardCitation(props: Readonly<{ citation: Citation; dashboard: Dashboard; onOpenMessage: (id: string | null) => void }>) {
  const content = (): JSX.Element => {
    const citation = props.citation;
    switch (citation.kind) {
      case 'message': return <div class="message-citation"><Show when={props.dashboard.board?.some(message => message.id === citation.id)} fallback={<strong>{boardKinds[citation.message.kind]} · {actorName(citation.message.author, props.dashboard)}</strong>}><a href={`#${encodeURIComponent(boardAnchor(citation.id))}`} onClick={event => { event.preventDefault(); props.onOpenMessage(citation.id); document.getElementById(boardAnchor(citation.id))?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }}>{boardKinds[citation.message.kind]} · {actorName(citation.message.author, props.dashboard)}</a></Show><p>{citation.message.summary}</p><small>{date(citation.message.at)}, {time(citation.message.at)} UTC</small></div>;
      case 'evidence': return <EvidenceCard evidence={citation.evidence} />;
      case 'unresolved': return <p class="unavailable-citation">Citation unavailable: <code>{citation.id}</code></p>;
    }
    const unhandled: never = citation;
    return unhandled;
  };
  return <li>{content()}</li>;
}

function BoardEntry(props: Readonly<{ message: BoardMessage; dashboard: Dashboard; onSelectShip: (id: string) => void; threadId: string | null; onOpenMessage: (id: string | null) => void }>) {
  const citations = createMemo(() => resolveBoardCitations(props.message, props.dashboard));
  const citedMessages = createMemo(() => citations().flatMap(citation => citation.kind === 'message' ? [citation.message] : []));
  const subjectId = () => concerns(props.message).shipmentId;
  const shipment = createMemo(() => props.dashboard.shipments.find(ship => ship.id === subjectId()));
  const details = (): JSX.Element => {
    const message = props.message;
    switch (message.kind) {
      case 'port.bulletin': return <div class="board-facts"><span class={`port-risk port-risk-${message.risk}`}>{message.risk}</span><span>{message.anchored} anchored</span><span>{message.arrivals48h} arrivals within 48h</span></div>;
      case 'city.traffic': return <><div class="board-facts"><span class={`port-risk port-risk-${message.risk}`}>{message.risk}</span><span>{message.anchored} anchored</span><span>{message.arrivals48h} arrivals within 48h</span></div><p class="board-meta">Assumed service rate: {message.basis.perHour} departures/hour. {message.basis.basis}</p></>;
      case 'city.hazards': return <><div class="board-facts"><span class={`port-risk port-risk-${message.risk}`}>{message.risk}</span></div><Show when={message.notices.length > 0} fallback={<p class="board-meta">No hazard notices supplied with this report.</p>}><For each={message.notices}>{notice => <article class="evidence"><div><strong>{notice.title}</strong></div><p>{notice.kind} · {notice.severity}</p><small>{notice.provider} · fetched {date(notice.fetchedAt)}, {time(notice.fetchedAt)} UTC</small></article>}</For></Show></>;
      case 'ship.observation': return <><div class="board-facts"><For each={message.signals}>{signal => <span>{signalLabel[signal]}</span>}</For></div><p class="board-meta">Observed by {message.provider}<Show when={message.nearPort}>{id => <> near {portName(props.dashboard.ports, id())}</>}</Show> · {date(message.observedAt)}, {time(message.observedAt)} UTC</p></>;
      case 'ship.assessment': return <><div class="board-facts"><RiskBadge risk={message.risk} /><span>{methodLabel[message.method]}</span><span>ETA {date(message.eta)}, {time(message.eta)} UTC</span></div><p class="board-meta">{message.confidence === null ? 'Confidence not supplied.' : `Model confidence ${Math.round(message.confidence * 100)}%.`}<Show when={message.delayHours}>{delay => <> Delay estimate {delay().low}–{delay().high}h; likely {delay().likely}h.</>}</Show> Method is not source provenance.</p><Show when={message.basis}>{basis => <p class="board-meta">Queue-drain rule at {portName(props.dashboard.ports, basis().portId)}: {basis().anchored} anchored vessels ÷ {basis().serviceRate.departuresPerHour} departures/hour ({basis().serviceRate.provenance} service rate).</p>}</Show></>;
      case 'ship.eta': return <p class="board-meta">{portName(props.dashboard.ports, message.portId)} arrival: {date(message.previousEta)}, {time(message.previousEta)} <ArrowRight size={13} /> {date(message.eta)}, {time(message.eta)} UTC</p>;
    }
    const unhandled: never = message;
    return unhandled;
  };
  return <article class="board-entry" id={boardAnchor(props.message.id)} tabIndex={-1}>
    <header><span class="board-kind">{boardKinds[props.message.kind]}</span><time dateTime={props.message.at}>{date(props.message.at)}, {time(props.message.at)} UTC</time></header>
    <h3>{actorName(props.message.author, props.dashboard)}</h3><Show when={citedMessages().length > 0}><ul class="board-edges" aria-label="Cited actors"><For each={citedMessages()}>{message => <li>Cites <strong>{actorName(message.author, props.dashboard)}</strong><span>{boardKinds[message.kind]}</span></li>}</For></ul></Show><p class="board-summary">{props.message.summary}</p>{details()}
    <Show when={citations().length > 0}><details class="board-citations" open={props.threadId === props.message.id} onToggle={event => { if (event.currentTarget.open) props.onOpenMessage(props.message.id); else if (props.threadId === props.message.id) props.onOpenMessage(null); }}><summary>Cites {citations().length} {citations().length === 1 ? 'item' : 'items'}</summary><p class="citation-note">References supplied by this actor, not proof of receipt by another actor.</p><ul><For each={citations()}>{citation => <BoardCitation citation={citation} dashboard={props.dashboard} onOpenMessage={props.onOpenMessage} />}</For></ul></details></Show>
    <Show when={shipment()}>{ship => <a class="board-ship-link" href="#shipment-details" onClick={event => { event.preventDefault(); props.onSelectShip(ship().id); }}><Ship size={14} />Inspect {ship().vessel}<ArrowRight size={14} /></a>}</Show>
  </article>;
}

function PortStatusList(props: Readonly<{ dashboard: Dashboard }>) {
  const ports = createMemo(() => props.dashboard.ports.map(port => ({ port, status: props.dashboard.portStatus?.find(status => status.portId === port.id) })).toSorted((left, right) =>
    Number((right.status?.relevance ?? 0) > 0) - Number((left.status?.relevance ?? 0) > 0)
    || (left.status ? portRiskOrder[left.status.risk] : 3) - (right.status ? portRiskOrder[right.status.risk] : 3)
    || (right.status?.relevance ?? 0) - (left.status?.relevance ?? 0)
    || left.port.name.localeCompare(right.port.name)));
  return <section class="society-section port-section" id="workspace-ports" aria-labelledby="ports-title"><div class="society-heading"><div><span class="section-kicker">PORT WATCH</span><h2 id="ports-title"><Anchor size={19} />Ports & route relevance</h2></div><a href="#workspace-shipments">Back to ships</a></div><p class="society-intro">Relevant ports serve the remaining routes of your workspace’s ships. Risk and relevance are separate signals.</p>
    <div class="port-status-list"><For each={ports()}>{entry => <article class="port-status-card"><header><div><h3>{entry.port.name}</h3><small>{entry.port.country}</small></div><Show when={entry.status} fallback={<span class="port-risk not-reported">Not reported</span>}>{status => <span class={`port-risk port-risk-${status().risk}`}>{status().risk}</span>}</Show></header><Show when={entry.status} fallback={<p class="muted">Route relevance and port conditions have not been reported.</p>}>{status => <><p class="port-relevance">{status().relevance} {status().relevance === 1 ? 'ship route' : 'ship routes'} in this workspace</p><Show when={status().bulletin} fallback={<p class="muted">No bulletin supplied with this status.</p>}>{bulletin => <><p>{bulletin().summary}</p><small>Port actor · {date(bulletin().at)}, {time(bulletin().at)} UTC</small><a class="port-board-link" href="#actor-board" onClick={event => { event.preventDefault(); document.getElementById('actor-board')?.scrollIntoView({ behavior: 'smooth' }); }}>Inspect actor board<ArrowRight size={13} /></a></>}</Show></>}</Show></article>}</For></div>
    <Show when={props.dashboard.ports.length === 0}><p class="society-empty">No ports are available in this workspace snapshot.</p></Show>
  </section>;
}

export function SocietyPanel(props: Readonly<{ dashboard: Dashboard; onSelectShip: (id: string) => void; threadId: string | null; onOpenMessage: (id: string | null) => void }>) {
  const messages = createMemo(() => props.dashboard.board?.toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at)));
  return <div class="society-layout"><PortStatusList dashboard={props.dashboard} /><section class="society-section board-section" id="actor-board" aria-labelledby="board-title"><div class="society-heading"><div><span class="section-kicker">SHARED ACTOR BOARD</span><h2 id="board-title"><MessageSquare size={19} />Observations & assessments</h2></div><a href="#workspace-shipments">Back to ships</a></div><p class="society-intro">Posts from your ship and port actors, newest first. Each post retains its author, method and citations.</p>
    <Show when={messages()} fallback={<p class="society-empty">The actor board has not been reported in this snapshot.</p>}>{reported => <><Show when={reported().length === 0}><p class="society-empty">No actor posts have been reported yet.</p></Show><div class="actor-board-list"><For each={reported()}>{message => <BoardEntry message={message} dashboard={props.dashboard} onSelectShip={props.onSelectShip} threadId={props.threadId} onOpenMessage={props.onOpenMessage} />}</For></div></>}</Show>
  </section></div>;
}
