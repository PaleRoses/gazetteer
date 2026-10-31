import { createEffect, createMemo, createSignal, on, onCleanup, Show } from 'solid-js';
import type { BoardAuthor, BoardMessage } from '../core/board';
import type { Dashboard } from '../core/types';
import { portName, time } from './presentation';

export const boardAnchor = (id: string): string => `actor-message-${id}`;
export const actorName = (author: BoardAuthor, dashboard: Dashboard): string => {
  switch (author.role) {
    case 'ship': return author.agent ? `${author.agent} aboard ${author.vessel}` : `${author.vessel} · ship actor`;
    case 'port': return `${portName(dashboard.ports, author.id)} · port actor`;
    case 'city': return `${portName(dashboard.ports, author.city)} · ${author.element === 'terminal' ? 'terminal desk' : `${author.element} watch`}`;
    case 'cargo': return `Cargo agent ${author.id} aboard ${author.vessel}`;
    case 'haulier': return `${portName(dashboard.ports, author.city)} · haulier`;
  }
  const unhandled: never = author;
  return unhandled;
};

export function PixelShip() {
  return <svg class="pixel-ship-glyph" viewBox="0 0 24 24" aria-hidden="true" shape-rendering="crispEdges"><path fill="currentColor" d="M11 3h2v5h5v4h4v5h-2v3H4v-3H2v-5h4V8h5z"/><path fill="var(--field)" d="M8 10h3v2H8zM13 10h3v2h-3z"/></svg>;
}

function ActorSprite(props: Readonly<{ author: BoardAuthor; label: string }>) {
  const hazards = () => props.author.role === 'city' && props.author.element === 'hazards';
  return <span class="actor-sprite" role="img" aria-label={`${props.label} · actor role symbol`}><Show when={props.author.role === 'ship'} fallback={<svg viewBox="0 0 28 26" aria-hidden="true" shape-rendering="crispEdges"><Show when={hazards()} fallback={<path fill="currentColor" d="M3 3h2v20H3zM5 3h19v2H5zM7 5h2v3H7zM11 5h2v6h-2zM15 5h2v9h-2zM19 5h2v12h-2zM21 5h2v13h-2zM17 18h10v7H17zM0 23h12v2H0z"/>}><path fill="currentColor" d="M5 3h14v2h4v7h-7l-3 6H9l2-6H3V5h2zM0 19h6v2H0zM7 21h7v2H7zM15 19h6v2h-6zM22 21h6v2h-6z"/></Show></svg>}><PixelShip /></Show></span>;
}

export function ActorLine(props: Readonly<{ dashboard: Dashboard; onOpenMessage: (id: string) => void }>) {
  const posts = createMemo<readonly BoardMessage[]>(() => props.dashboard.board?.toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at)) ?? []);
  const count = createMemo(() => posts().length);
  const newestId = createMemo(() => posts()[0]?.id);
  const [index, setIndex] = createSignal(0);
  const [paused, setPaused] = createSignal(false);
  createEffect(on(newestId, () => setIndex(0)));
  createEffect(() => {
    const size = count();
    const held = index();
    if (paused() || size < 2) return;
    const timer = window.setTimeout(() => setIndex((held + 1) % size), 6500);
    onCleanup(() => window.clearTimeout(timer));
  });
  const current = createMemo(() => posts()[index() % (count() || 1)]);
  return <div class="actor-line"><Show when={current()} fallback={<p class="actor-waiting">{props.dashboard.board === undefined ? 'Actor messages have not been reported.' : 'No actor messages are available in this snapshot.'}</p>}>{message => <><ActorSprite author={message().author} label={actorName(message().author, props.dashboard)} /><a class="actor-dispatch" href={`#${encodeURIComponent(boardAnchor(message().id))}`} onClick={() => props.onOpenMessage(message().id)}><span class="actor-byline">{actorName(message().author, props.dashboard)}<time dateTime={message().at}>{time(message().at)} UTC</time></span><span class="actor-summary">{message().summary}</span></a><a class="ticker-thread" href={`#${encodeURIComponent(boardAnchor(message().id))}`} onClick={() => props.onOpenMessage(message().id)}>View thread →</a><Show when={count() > 1}><button class="ticker-pause" type="button" aria-label={paused() ? 'Resume actor ticker' : 'Pause actor ticker'} aria-pressed={paused()} onClick={() => setPaused(value => !value)}>{paused() ? '▶' : 'Ⅱ'}</button></Show></>}</Show></div>;
}
