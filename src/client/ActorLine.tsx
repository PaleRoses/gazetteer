import { ArrowRight } from 'lucide-solid';
import { createEffect, createMemo, createSignal, Match, on, onCleanup, Show, Switch } from 'solid-js';
import type { BoardAuthor, BoardMessage } from '../core/board';
import type { Dashboard, Shipment } from '../core/types';
import { portName } from './presentation';
import { PixelCrane, PixelShip, PixelTruck, RiskMark, riskColour, selectionColour } from './sprites';
import './styles/ticker.css';

export { PixelShip } from './sprites';

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

type Sprite = 'crane' | 'ship' | 'truck';

const spriteOf = (author: BoardAuthor): Sprite => {
  switch (author.role) {
    case 'ship': case 'cargo': return 'ship';
    case 'haulier': return 'truck';
    case 'port': case 'city': return 'crane';
  }
  const unhandled: never = author;
  return unhandled;
};

const palette = { '--risk-delayed': riskColour.delayed, '--risk-watch': riskColour.watch, '--risk-on-track': riskColour['on-track'], '--selection': selectionColour };

const clock = (value: string): string => new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

const placeOf = (author: BoardAuthor, dashboard: Dashboard): string => {
  switch (author.role) {
    case 'ship': case 'cargo': return author.vessel;
    case 'port': return portName(dashboard.ports, author.id);
    case 'city': case 'haulier': return portName(dashboard.ports, author.city);
  }
  const unhandled: never = author;
  return unhandled;
};

const riskOf = (author: BoardAuthor, dashboard: Dashboard): Shipment['risk'] | undefined => {
  switch (author.role) {
    case 'ship': return dashboard.shipments.find(shipment => shipment.id === author.id)?.risk;
    case 'cargo': return dashboard.shipments.find(shipment => shipment.vessel === author.vessel)?.risk;
    case 'port': case 'city': case 'haulier': return undefined;
  }
  const unhandled: never = author;
  return unhandled;
};

function ActorSprite(props: Readonly<{ author: BoardAuthor; dashboard: Dashboard; label: string }>) {
  const sprite = () => spriteOf(props.author);
  const risk = () => riskOf(props.author, props.dashboard) ?? 'on-track';
  return <span class={sprite() === 'ship' ? `actor-sprite ship ${risk()}` : `actor-sprite ${sprite()}`} role="img" aria-label={`${props.label} · actor role symbol`}>
    <Switch>
      <Match when={sprite() === 'crane'}><PixelCrane /></Match>
      <Match when={sprite() === 'truck'}><PixelTruck /></Match>
      <Match when={sprite() === 'ship'}><PixelShip /><RiskMark risk={risk()} /></Match>
    </Switch>
  </span>;
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
  return <div class="actor-line" style={palette}><Show when={current()} fallback={<p class="actor-waiting">{props.dashboard.board === undefined ? 'Actor messages have not been reported.' : 'No actor messages are available in this snapshot.'}</p>}>{message => <>
    <ActorSprite author={message().author} dashboard={props.dashboard} label={actorName(message().author, props.dashboard)} />
    <a class="actor-dispatch" href={`#${encodeURIComponent(boardAnchor(message().id))}`} onClick={() => props.onOpenMessage(message().id)}><span class="actor-byline">{placeOf(message().author, props.dashboard)} · <time dateTime={message().at}>{clock(message().at)} UTC</time></span><span class="actor-summary">{message().summary}</span></a>
    <a class="ticker-thread" href={`#${encodeURIComponent(boardAnchor(message().id))}`} onClick={() => props.onOpenMessage(message().id)}>View thread <ArrowRight size={20} stroke-width={1.75} aria-hidden="true" /></a>
    <Show when={count() > 1}><span class="ticker-divider" aria-hidden="true" /><button class="ticker-pause" type="button" aria-label="Pause actor ticker" aria-pressed={paused()} onClick={() => setPaused(value => !value)}><span /><span /></button></Show>
  </>}</Show></div>;
}
