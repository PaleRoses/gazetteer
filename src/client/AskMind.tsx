import { createMemo, createSignal, For, Match, Show, Switch } from 'solid-js';
import { Send, TriangleAlert } from 'lucide-solid';
import type { Dashboard, Shipment } from '../core/types';
import { boardAnchor } from './ActorLine';
import { actorName } from './board-view';
import { request } from './api';
import { askAnswerSchema, askOutcome, type AskState } from './ask';
import { resolveCitationIds, type Citation } from './citations';
import './styles/ask.css';

function Cited(props: Readonly<{ citation: Citation; dashboard: Dashboard }>) {
  const citation = props.citation;
  switch (citation.kind) {
    case 'message': return <a class="mind-cite" href={`#${encodeURIComponent(boardAnchor(citation.id))}`}><span>{actorName(citation.message.author, props.dashboard)}</span>{citation.message.summary}</a>;
    case 'evidence': return <span class="mind-cite evidence-cite"><span>{citation.evidence.source === 'live' ? citation.evidence.provider : 'Simulated source'}</span>{citation.evidence.title}</span>;
    case 'unresolved': return <span class="mind-cite unresolved-cite">Not on the board now: <code>{citation.id}</code></span>;
  }
}

/** Ask the mind aboard. It answers from what it has heard and changes nothing; what it cites links to the board. */
export function AskMind(props: Readonly<{ workspaceId: string; ship: Shipment; dashboard: Dashboard }>) {
  const [ask, setAsk] = createSignal<AskState>({ state: 'idle' });
  const busy = () => ask().state === 'asking';
  const answered = createMemo(() => { const value = ask(); return value.state === 'answered' ? value : undefined; });
  const away = createMemo(() => { const value = ask(); return value.state === 'unavailable' ? value : undefined; });
  const failed = createMemo(() => { const value = ask(); return value.state === 'failed' ? value : undefined; });
  async function put(question: string): Promise<boolean> {
    if (question === '' || busy()) return false;
    setAsk({ state: 'asking', question });
    const result = await request(`/api/workspaces/${props.workspaceId}/shipments/${props.ship.id}/ask`, askAnswerSchema, { question });
    setAsk(askOutcome(question, result));
    return result.ok;
  }
  async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const form = event.currentTarget;
    const value = new FormData(form).get('question');
    if (await put(typeof value === 'string' ? value.trim() : '')) form.reset();
  }
  return <section class="detail-section ask-mind" aria-labelledby="ask-title">
    <h3 id="ask-title">Ask {props.ship.agent}</h3>
    <p>{props.ship.agent} is the mind aboard {props.ship.vessel}. It answers from what it has heard on the Relay and changes nothing.</p>
    <form onSubmit={submit}><label class="sr-only" for="ask-question">Question for {props.ship.agent}</label><textarea id="ask-question" name="question" rows={2} maxLength={500} required placeholder={props.ship.risk === 'on-track' ? 'What could still delay you?' : 'Why are you late?'} disabled={busy()} /><button class="text-button" disabled={busy()}>{busy() ? `${props.ship.agent} is thinking…` : `Ask ${props.ship.agent}`}<Send size={13} /></button></form>
    <Switch>
      <Match when={answered()}>{value => <article class="mind-answer"><span class="mind-question">You asked: {value().question}</span><span class="mind-name">{value().mind} answers</span><p>{value().answer}</p><Show when={value().cited.length > 0} fallback={<small class="muted">Cites nothing from the board.</small>}><span class="mind-cites-label">Cites</span><ul class="mind-cites"><For each={resolveCitationIds(value().cited, props.dashboard)}>{citation => <li><Cited citation={citation} dashboard={props.dashboard} /></li>}</For></ul></Show></article>}</Match>
      <Match when={away()}>{value => <div class="mind-away" role="status"><TriangleAlert size={15} /><span><strong>{props.ship.agent} is unavailable.</strong> {value().message}</span><button type="button" class="text-button" onClick={() => { void put(value().question); }}>Ask again</button></div>}</Match>
      <Match when={failed()}>{value => <p class="error-note" role="alert"><TriangleAlert size={15} />{value().message}</p>}</Match>
    </Switch>
  </section>;
}
