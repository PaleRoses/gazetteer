import { For, Show } from 'solid-js';
import type { RecoveryView } from '../core/reservations';
import { clock, countdown } from './recovery-view';

type Reservation = RecoveryView['reservations'][number];
const statusOrder: Readonly<Record<Reservation['status'], number>> = { held: 0, confirmed: 1, released: 2, expired: 3 };

/** Every sandbox reservation of the case as the ledger records it: held (with its time left), confirmed, released or expired. */
export function Reservations(props: Readonly<{ reservations: readonly Reservation[]; now: number }>) {
  const rows = () => props.reservations.toSorted((left, right) => statusOrder[left.status] - statusOrder[right.status] || Date.parse(left.start) - Date.parse(right.start));
  return <section class="reservations" aria-labelledby="reservations-title">
    <h3 id="reservations-title">Reservations</h3>
    <Show when={rows().length > 0} fallback={<p class="recovery-quiet">No holds yet. The cargo agent holds before it books.</p>}>
      <ul><For each={rows()}>{item => <li class={`reservation ${item.status}`}>
        <div><strong>{item.resource}</strong><small>{clock(item.start)}–{clock(item.end)} UTC · EUR {item.priceEur.toLocaleString('en-US')}</small></div>
        <span class={`chip ${item.status}`}>{item.status === 'held' ? `held · ${countdown(item.expiresAt, props.now) ?? 'lapsing'}` : item.status}</span>
      </li>}</For></ul>
    </Show>
  </section>;
}
