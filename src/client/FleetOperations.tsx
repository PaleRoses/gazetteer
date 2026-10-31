import { createEffect, createSignal, For, Show, type Accessor } from 'solid-js';
import { Portal } from 'solid-js/web';
import { Dialog } from '@ark-ui/solid';
import { Bell, Check, Plus, Save, Ship, Trash2, X } from 'lucide-solid';
import type { Dashboard, Shipment } from '../shared';
import { defaultAlertPreferences, vesselInputSchema, type Operation } from '../operations';
import './fleet-operations.css';

type Execute = (operation: Operation) => Promise<boolean>;
const stamp = (at: string) => new Date(at).toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }) + ' UTC';
const field = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const iso = (value: string) => new Date(`${value}:00Z`).toISOString();

export function VesselEditor(props: { shipment?: Shipment; dashboard: Dashboard; busy: boolean; error: string | null; execute: Execute; close: () => void }) {
  const [invalid, setInvalid] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal(false);
  const ship = props.shipment;
  const departure = ship?.voyage?.departure ?? ship?.milestones[0]?.at ?? new Date().toISOString();
  const eta = ship?.eta ?? new Date(Date.now() + 7 * 86400000).toISOString();
  async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault(); setInvalid(null);
    const form = new FormData(event.currentTarget);
    const parsed = vesselInputSchema.safeParse({ id: ship?.id, vessel: field(form, 'vessel'), identity: { imo: field(form, 'imo'), mmsi: field(form, 'mmsi') }, origin: field(form, 'origin'), destination: field(form, 'destination'), via: field(form, 'via').split(',').filter(Boolean), departure: iso(field(form, 'departure')), eta: iso(field(form, 'eta')), status: field(form, 'status') });
    if (!parsed.success) { setInvalid(parsed.error.issues[0]?.message ?? 'Check your voyage details.'); return; }
    if (await props.execute({ action: 'save', vessel: parsed.data })) props.close();
  }
  return <Dialog.Root open onOpenChange={details => { if (!details.open && !props.busy) props.close(); }}><Portal><Dialog.Backdrop class="modal-dim" /><Dialog.Positioner class="modal-backdrop"><Dialog.Content class="fleet-dialog">
    <Dialog.CloseTrigger class="icon-button dialog-close" aria-label="Close vessel editor" disabled={props.busy}><X size={20} /></Dialog.CloseTrigger>
    <span class="section-kicker">YOUR FLEET</span><Dialog.Title>{ship ? 'Edit vessel & voyage' : 'Add a vessel'}</Dialog.Title><Dialog.Description>Enter the vessel identity and voyage plan. Positions remain simulated; identity is not checked against a vessel registry.</Dialog.Description>
    <form onSubmit={submit} class="fleet-form"><label class="full-row">Vessel name<input name="vessel" value={ship?.vessel ?? ''} required maxLength={100} placeholder="e.g. Gulf Horizon" /></label>
      <label>IMO number<input name="imo" inputmode="numeric" value={ship?.identity?.imo ?? ''} maxLength={7} placeholder="7 digits" /></label><label>MMSI<input name="mmsi" inputmode="numeric" value={ship?.identity?.mmsi ?? ''} maxLength={9} placeholder="9 digits" /></label>
      <p class="form-hint full-row">{ship ? 'Identifiers are optional for seeded demo vessels.' : 'Provide at least one identifier. IMO check digits are validated.'}</p>
      <label>Previous / departure port<select name="origin" value={ship?.origin ?? 'jebel-ali'}><For each={props.dashboard.ports}>{port => <option value={port.id}>{port.name}</option>}</For></select></label>
      <label>Destination port<select name="destination" value={ship?.destination ?? 'singapore'}><For each={props.dashboard.ports}>{port => <option value={port.id}>{port.name}</option>}</For></select></label>
      <label class="full-row">Intermediate ports<select name="via" value={ship?.via.join(',') ?? ''}><option value="">Direct voyage</option><Show when={ship && ship.via.length > 1}><option value={ship!.via.join(',')}>{ship!.via.join(' → ')}</option></Show><For each={props.dashboard.ports}>{port => <option value={port.id}>{port.name}</option>}</For></select></label>
      <label>Departure · UTC<input name="departure" type="datetime-local" value={departure.slice(0, 16)} required /></label><label>Expected arrival · UTC<input name="eta" type="datetime-local" value={eta.slice(0, 16)} required /></label>
      <label class="full-row">Operator-reported status<select name="status" value={ship?.voyage?.status ?? (ship ? 'underway' : 'planned')}><option value="planned">Planned</option><option value="underway">Underway — departed</option><option value="stopped">Stopped</option><option value="arrived">Arrived at destination</option></select></label>
      <p class="form-hint full-row">Demo covers these five ports. Saving sets a new ETA baseline and clears earlier risk assessments for this voyage. Departure and arrival alerts use your reported status.</p>
      <Show when={invalid() ?? props.error}>{message => <p class="error-note full-row" role="alert">{message()}</p>}</Show>
      <div class="fleet-form-actions full-row"><Show when={ship}><button type="button" class="danger-button" disabled={props.busy} onClick={() => setRemoving(!removing())}><Trash2 size={14} />Remove from fleet</button></Show><button class="primary" disabled={props.busy}>{ship ? <Save size={15} /> : <Plus size={15} />}{props.busy ? 'Saving…' : ship ? 'Save voyage' : 'Add vessel'}</button></div>
      <Show when={removing() && ship}><div class="remove-confirm full-row"><p>Remove {ship?.vessel} from this shared fleet? Its agent will stop monitoring. Existing alerts and team notes are retained.</p><button type="button" class="danger-button" disabled={props.busy} onClick={async () => { if (await props.execute({ action: 'remove', id: ship!.id })) props.close(); }}>Confirm removal</button><button type="button" onClick={() => setRemoving(false)}>Keep vessel</button></div></Show>
    </form>
  </Dialog.Content></Dialog.Positioner></Portal></Dialog.Root>;
}

export function VoyageFacts(props: { shipment: Shipment; dashboard: Dashboard; edit: () => void }) {
  const port = (id: string) => props.dashboard.ports.find(p => p.id === id)?.name ?? id;
  return <section class="voyage-facts"><div class="voyage-facts-heading"><span class="section-kicker">VESSEL & VOYAGE</span><button class="text-button" onClick={props.edit}>Edit voyage</button></div>
    <div class="identity-line">{props.shipment.identity?.imo ? `IMO ${props.shipment.identity.imo}` : 'IMO not entered'} · {props.shipment.identity?.mmsi ? `MMSI ${props.shipment.identity.mmsi}` : 'MMSI not entered'}</div>
    <dl><div><dt>Previous / departure port</dt><dd>{port(props.shipment.origin)}</dd></div><div><dt>Next port</dt><dd>{port(props.shipment.via[0] ?? props.shipment.destination)}</dd></div><div><dt>Departure</dt><dd>{stamp(props.shipment.voyage?.departure ?? props.shipment.milestones[0]?.at ?? props.dashboard.updatedAt)}</dd></div><div><dt>Current ETA</dt><dd>{stamp(props.shipment.eta)}</dd></div><div><dt>Reported status</dt><dd>{props.shipment.voyage?.status ?? 'Underway · demo'}</dd></div></dl>
    <p>{props.shipment.voyage ? <>Plan entered by {props.shipment.voyage.updatedBy} · {stamp(props.shipment.voyage.updatedAt)}. {props.shipment.eta !== props.shipment.voyage.eta ? 'Current ETA includes agent adjustments.' : 'ETA supplied by operator.'}</> : 'Seeded demo voyage. Edit to supply your own plan.'}</p>
  </section>;
}

export function createAlertNotifications(workspaceId: string, dashboard: Accessor<Dashboard | null | undefined>, openVoyage: (id: string) => void) {
  const key = `gazetteer.notifications.${workspaceId}`;
  const available = typeof Notification !== 'undefined';
  const [permission, setPermission] = createSignal(available ? Notification.permission : 'unsupported');
  const [enabled, setEnabled] = createSignal(localStorage.getItem(key) === 'on' && available && Notification.permission === 'granted');
  const seen = new Set<string>();
  let initialized = false;
  createEffect(() => {
    const alerts = dashboard()?.operations?.alerts;
    if (!alerts) return;
    for (const alert of [...alerts].reverse()) {
      if (initialized && enabled() && !seen.has(alert.id) && !alert.acknowledgedAt && Notification.permission === 'granted') {
        const receipt = `${key}.${alert.id}`;
        if (!localStorage.getItem(receipt)) {
          try {
            const notification = new Notification(`${alert.vessel}: ${alert.title}`, { body: `${alert.source.toUpperCase()} · ${alert.detail}`, tag: `${workspaceId}:${alert.id}` });
            localStorage.setItem(receipt, 'sent');
            notification.onclick = () => { window.focus(); openVoyage(alert.shipmentId); notification.close(); };
          } catch { setPermission('unsupported'); setEnabled(false); }
        }
      }
      seen.add(alert.id);
    }
    initialized = true;
  });
  return { enabled, permission, async toggle() {
    if (enabled()) { setEnabled(false); localStorage.removeItem(key); return; }
    if (!available) return;
    const result = await Notification.requestPermission(); setPermission(result);
    if (result === 'granted') { localStorage.setItem(key, 'on'); setEnabled(true); }
  } };
}

export function AlertsPage(props: { dashboard?: Dashboard | null; busy: boolean; error: string | null; execute: Execute; openVoyage: (id: string) => void; notifications: ReturnType<typeof createAlertNotifications> }) {
  const [all, setAll] = createSignal(false);
  const [saved, setSaved] = createSignal(false);
  const preferences = () => props.dashboard?.operations?.preferences ?? defaultAlertPreferences;
  const alerts = () => props.dashboard?.operations?.alerts ?? [];
  const pending = () => alerts().filter(a => !a.acknowledgedAt);
  async function save(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault(); setSaved(false); const form = new FormData(event.currentTarget);
    setSaved(await props.execute({ action: 'preferences', preferences: { etaHours: Number(field(form, 'eta')), stopHours: Number(field(form, 'stop')), staleHours: Number(field(form, 'stale')) } }));
  }
  return <main class="alerts-page"><header class="alerts-header"><span class="section-kicker">EXCEPTIONS, NOT NOISE</span><h1><Bell size={26} />Fleet alerts <span>{pending().length} open</span></h1><p>Changes that need a human decision. Acknowledgements are shared across your workspace.</p></header>
    <section class="alert-settings"><div><h2>When to alert</h2><p>Arrival and departure alerts use operator-reported status. Stops use time since a vessel was marked stopped. Stale-position alerts require a telemetry report; simulated reports stay labelled.</p><form onSubmit={save}><label>ETA change ≥<span><input name="eta" type="number" min="0.25" max="168" step="0.25" required value={preferences().etaHours} />hours</span></label><label>Stopped for ≥<span><input name="stop" type="number" min="0.25" max="168" step="0.25" required value={preferences().stopHours} />hours</span></label><label>Position age ≥<span><input name="stale" type="number" min="0.25" max="168" step="0.25" required value={preferences().staleHours} />hours</span></label><button class="primary" disabled={props.busy || !props.dashboard}>{saved() ? 'Saved' : 'Save thresholds'}</button></form></div>
      <div class="notification-setting"><Bell size={21} /><h2>Desktop notifications</h2><p>Receive new alerts while this workspace stays open in a browser tab, including in the background.</p><button class="notification-button" disabled={props.notifications.permission() === 'unsupported'} onClick={() => { void props.notifications.toggle(); }}>{props.notifications.enabled() ? 'Disable notifications' : 'Enable notifications'}</button><small>{props.notifications.permission() === 'denied' ? 'Blocked by your browser. Allow notifications in site settings to enable.' : props.notifications.permission() === 'unsupported' ? 'This browser does not support desktop notifications. Use the alert inbox.' : props.notifications.enabled() ? 'Enabled on this browser. Closing the tab stops delivery.' : 'Off on this browser. Permission is requested when you enable.'}</small></div>
    </section>
    <Show when={props.error}><p role="alert" class="error-note">{props.error}</p></Show>
    <div class="alert-list-heading"><h2>{all() ? 'Recent alerts' : 'Needs acknowledgement'}</h2><button class="text-button" onClick={() => setAll(!all())}>{all() ? 'Show open only' : 'Include acknowledged'}</button></div>
    <div class="alert-list"><For each={all() ? alerts() : pending()}>{alert => <article class="alert-card" classList={{ acknowledged: !!alert.acknowledgedAt }}><div class="alert-symbol">{alert.acknowledgedAt ? <Check size={19} /> : <Bell size={19} />}</div><div class="alert-copy"><div class="alert-meta"><span class={`alert-source ${alert.source}`}>{alert.source}</span><span>{stamp(alert.createdAt)}</span></div><h3>{alert.vessel} <span>· {alert.title}</span></h3><p>{alert.detail}</p><div class="alert-actions"><Show when={props.dashboard?.shipments.some(s => s.id === alert.shipmentId)} fallback={<span>Vessel removed from fleet</span>}><button onClick={() => props.openVoyage(alert.shipmentId)}><Ship size={13} />Open voyage</button></Show><Show when={!alert.acknowledgedAt} fallback={<span>Acknowledged {stamp(alert.acknowledgedAt!)}</span>}><button disabled={props.busy} onClick={() => { void props.execute({ action: 'acknowledge', id: alert.id }); }}><Check size={14} />Acknowledge</button></Show></div></div></article>}</For>
      <Show when={(all() ? alerts() : pending()).length === 0}><div class="alerts-empty"><Check size={28} /><h2>{props.dashboard ? 'Nothing needs your attention' : 'Loading fleet alerts…'}</h2><p>Alerts appear when a monitored change crosses a threshold. Try revising a vessel’s ETA or running the Singapore disruption scenario.</p></div></Show></div>
  </main>;
}
