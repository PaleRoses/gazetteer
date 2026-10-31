import { createMemo, createSignal, For, onCleanup, Show, type JSX } from 'solid-js';
import { TriangleAlert } from 'lucide-solid';
import { describeConstraint } from '../core/recovery';
import type { BoardAuthor } from '../core/board';
import type { Dashboard } from '../core/types';
import { dashboardSchema, request } from './api';
import { actorName, boardKinds } from './board-view';
import { Reservations } from './Reservations';
import { clock, currentBlocker, litSteps, recoverySteps, recoveryThread } from './recovery-view';
import { PixelCrane, PixelShip, PixelTruck } from './sprites';
import './styles/recovery.css';

type Control = 'delay-meridian-star' | 'withdraw-truck' | 'restart-cargo';

function Sprite(props: Readonly<{ author: BoardAuthor }>): JSX.Element {
  switch (props.author.role) {
    case 'haulier': return <span class="recovery-sprite haulier"><PixelTruck /></span>;
    case 'city': case 'port': return <span class="recovery-sprite desk"><PixelCrane /></span>;
    case 'cargo': case 'ship': return <span class="recovery-sprite cargo"><PixelShip /></span>;
  }
}

/** Act 2 as the agents live it: the steps their own posts have reached, the negotiation, the blocker, the reservations and the delivery it recovers. */
export function RecoveryPanel(props: Readonly<{ workspaceId: string; dashboard: Dashboard | null; onDashboard: (dashboard: Dashboard) => void }>) {
  const [busy, setBusy] = createSignal<Control | null>(null);
  const [withdrawn, setWithdrawn] = createSignal(false);
  const [restartedAt, setRestartedAt] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const tick = window.setInterval(() => setNow(Date.now()), 1_000);
  onCleanup(() => window.clearInterval(tick));

  const recovery = () => props.dashboard?.recovery;
  const caseId = () => recovery()?.case?.caseId ?? null;
  const thread = createMemo(() => recoveryThread(props.dashboard?.board ?? [], caseId()));
  const lit = createMemo(() => litSteps(thread(), caseId() !== null, restartedAt()));
  const blocker = createMemo(() => currentBlocker(thread()));
  const byId = (id: string) => props.dashboard?.board?.find(message => message.id === id);

  async function press(control: Control) {
    setBusy(control); setError(null);
    const pressedAt = new Date().toISOString();
    const result = await request(`/api/workspaces/${props.workspaceId}/${control}`, dashboardSchema, {});
    setBusy(null);
    if (!result.ok) { setError(result.error); return; }
    if (control === 'withdraw-truck') setWithdrawn(true);
    if (control === 'restart-cargo') setRestartedAt(pressedAt);
    props.onDashboard(result.value);
  }

  return <section class="recovery" id="recovery" aria-labelledby="recovery-title">
    <header class="recovery-head">
      <div><span class="recovery-kicker">ACT 2 · RECOVERY</span><h2 id="recovery-title">The agents save the refrigerated shipment</h2></div>
      <div class="recovery-controls" role="group" aria-label="Act 2 controls">
        <button type="button" class="recovery-button primary-action" disabled={busy() !== null || caseId() !== null || !props.dashboard} onClick={() => { void press('delay-meridian-star'); }}>{busy() === 'delay-meridian-star' ? 'Delaying…' : 'Delay Meridian Star'}</button>
        <Show when={recovery()}>
          <button type="button" class="recovery-button" disabled={busy() !== null || withdrawn()} onClick={() => { void press('withdraw-truck'); }}>{busy() === 'withdraw-truck' ? 'Withdrawing…' : withdrawn() ? 'Truck withdrawn' : 'Withdraw truck'}</button>
          <button type="button" class="recovery-button" disabled={busy() !== null} onClick={() => { void press('restart-cargo'); }}>{busy() === 'restart-cargo' ? 'Restarting…' : 'Restart cargo agent (resumes from its saved case)'}</button>
        </Show>
      </div>
    </header>
    <Show when={error()}>{message => <p class="recovery-error" role="alert"><TriangleAlert size={15} />{message()}</p>}</Show>
    <Show when={recovery()} fallback={<p class="recovery-quiet">Act 2 has not started. Delay Meridian Star and its cargo agent opens a recovery case.</p>}>{view => <>
      <ol class="recovery-steps"><For each={recoverySteps}>{(step, index) => <li classList={{ lit: lit().has(step.id) }}><span class="step-number">{index() + 1}</span>{step.label}</li>}</For></ol>
      <Show when={blocker()}>{blocking => <p class="recovery-blocker" role="status"><strong>Blocking constraint</strong> · {describeConstraint(blocking())}</p>}</Show>
      <div class="recovery-body">
        <section class="recovery-thread" aria-labelledby="negotiation-title">
          <h3 id="negotiation-title">Negotiation</h3>
          <Show when={thread().length > 0} fallback={<p class="recovery-quiet">The case is open; the cargo agent's first request has not reached the board yet.</p>}>
            <ol><For each={thread()}>{item => <li>
              <Sprite author={item.post.author} />
              <div><span class="thread-author">{actorName(item.post.author, props.dashboard ?? { ports: [] })}<span>{boardKinds[item.post.kind]} · {clock(item.post.at)} UTC</span></span>
                <p>{item.post.summary}</p>
                <Show when={item.post.answers.length > 0}><small class="thread-answers">answers {item.post.answers.map(id => { const answered = byId(id); return answered ? actorName(answered.author, props.dashboard ?? { ports: [] }) : 'a post no longer on the board'; }).join(', ')}</small></Show>
              </div>
            </li>}</For></ol>
          </Show>
        </section>
        <aside class="recovery-side">
          <Reservations reservations={view().reservations} now={now()} />
          <div class="recovered" classList={{ pending: !view().case?.delivered }}>
            <span>Recovered delivery</span>
            <Show when={view().case?.delivered} fallback={<strong>pending</strong>}>{delivered => <strong>{clock(delivered())} UTC</strong>}</Show>
            <Show when={view().case?.plan}>{plan => <small>EUR {plan().totalEur.toLocaleString('en-US')} · truck departs {clock(plan().departs)} UTC · negotiated by rule</small>}</Show>
          </div>
        </aside>
      </div>
    </>}</Show>
  </section>;
}
