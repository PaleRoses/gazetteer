import { AlertsPage, VesselEditor, VoyageFacts, createAlertNotifications } from './FleetOperations';
import type { Operation } from '../core/operations';
import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { render, Portal } from 'solid-js/web';
import { Dialog, Menu, Tabs } from '@ark-ui/solid';
import { ArrowDownRight, ArrowRight, Bell, Check, ChevronDown, FlaskConical, Layers3, LogOut, MapPin, MessageSquare, Plus, Radio, Search, Send, Ship, TriangleAlert, Users, X } from 'lucide-solid';
import { z } from 'zod';
import type { Comment, Dashboard, Diversion, Shipment, Workspace } from '../core/types';
import { commentsSchema, dashboardSchema, invitationSchema, membersSchema, request, sessionSchema, workspaceSchema, type Invitation, type Session } from './api';
import { MapBackdrop, ShipmentMap } from './Map';
import { mergeComment, type CommentEvent } from './feed';
import { createChangeFlash, createWorkspaceFeed, type FeedMode } from './live';
import { ActorLine, PixelShip } from './ActorLine';
import { SocietyPanel } from './SocietyPanel';
import { date, EvidenceCard, portName, RiskBadge, time } from './presentation';
import { AgentBoard } from './AgentBoard';
import { SimulationPage } from './SimulationPage';
import type { SimulationResult } from '../core/simulation';
import { NewsPage } from './NewsPage';
import './feed-pages.css';
import { RouteCard, RouteDetails, routeName } from './Routes';
import { readView, viewHash, type View } from './navigation';
import { shipmentBrief, assessmentFor } from './brief';
import './styles.css';

const minute = (eta: string | undefined): string => (eta ?? '').slice(0, 16);
const feedLabel: Readonly<Record<FeedMode, string>> = { connecting: 'CONNECTING', live: 'STREAMING', polling: 'POLLING · 5 S' };
const textField = (data: FormData, key: string): string => { const value = data.get(key); return typeof value === 'string' ? value : ''; };
const DECLINED_DEMO = 'gazetteer.demo.declined';
const DEMO_EMAIL = 'demo@gazetteer.local';
/** Resolves to an error message, or undefined once the session is set. */
async function enterDemo(onSession: (session: Session) => void): Promise<string | undefined> {
  const result = await request('/api/demo-session', sessionSchema, {});
  if (!result.ok) return result.error;
  window.sessionStorage.removeItem(DECLINED_DEMO);
  onSession(result.value);
  return undefined;
}
const ErrorNote = (props: Readonly<{ message: string }>) => <p class="error-note" role="alert"><TriangleAlert size={15} />{props.message}</p>;

function Brand() { return <a class="brand" href="/" aria-label="Gazetteer home">gazetteer</a>; }

function Authentication(props: Readonly<{ onSession: (session: Session) => void; demo: boolean }>) {
  const [mode, setMode] = createSignal<'signup' | 'login'>('signup');
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const invited = new URLSearchParams(window.location.search).has('invite');
  const signup = () => mode() === 'signup';
  async function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null);
    const result = await request(`/api/${mode()}`, sessionSchema, { email: textField(data, 'email'), password: textField(data, 'password'), ...(signup() ? { name: textField(data, 'name'), workspaceName: textField(data, 'workspaceName') || undefined } : {}) });
    setBusy(false);
    if (result.ok) props.onSession(result.value); else setError(result.error);
  }
  return <main class="auth-shell"><section class="auth-story"><Brand /><div class="auth-map"><MapBackdrop /></div><div class="auth-copy"><span class="eyebrow"><Radio size={14} /> A SHARED VIEW OF WHAT'S NEXT</span><h1>Cargo moves.<br />Stay ahead.</h1><p>Your ships, their arrival times, and the changes that matter. All in one shared workspace.</p><div class="auth-features"><span><MapPin size={16} />Follow every ship</span><span><TriangleAlert size={16} />See what needs attention</span><span><Users size={16} />Make the next call together</span></div></div><div class="auth-foot"><span>GAZETTEER / OPERATIONS</span><span>Clarity from origin to destination.</span></div></section>
    <section class="auth-panel"><div class="auth-form-wrap"><Show when={props.demo}><button type="button" class="demo-skip" disabled={busy()} onClick={() => { void enterDemo(props.onSession).then(failed => { if (failed) setError(failed); }); }}><span class="demo-skip-label"><FlaskConical size={20} />Skip — open the demo workspace</span><small>No account needed. Simulated fleet, live map.</small><ArrowRight size={22} /></button><p class="demo-or"><span>or sign in with your account</span></p></Show><span class="demo-tag"><FlaskConical size={13} /> SYNTHETIC DEMO</span><h2>{invited ? 'Join your team.' : signup() ? 'Your next clear view.' : 'Welcome back.'}</h2><p>{invited ? 'Sign in with your invited email, then accept your workspace invitation.' : signup() ? 'Create an account to explore your shared ship workspace.' : 'Sign in to pick up where your team left off.'}</p>
      <Tabs.Root value={mode()} onValueChange={details => { setMode(details.value === 'login' ? 'login' : 'signup'); setError(null); }}><Tabs.List class="auth-tabs"><Tabs.Trigger value="signup">Create account</Tabs.Trigger><Tabs.Trigger value="login">Sign in</Tabs.Trigger></Tabs.List></Tabs.Root>
      <form onSubmit={submit}><Show when={signup()}><label>Your name<input name="name" autocomplete="name" maxLength={80} required placeholder="Alex Morgan" /></label></Show><label>Email<input name="email" type="email" autocomplete="email" required placeholder="you@company.com" /></label><label>Password<input name="password" type="password" autocomplete={signup() ? 'new-password' : 'current-password'} minLength={12} required placeholder="At least 12 characters" /></label><Show when={signup()}><label>Workspace name <span class="optional">optional</span><input name="workspaceName" maxLength={100} placeholder="Your logistics team" /></label></Show><Show when={error()}>{message => <ErrorNote message={message()} />}</Show><button class="primary full" disabled={busy()}>{busy() ? 'Connecting…' : signup() ? 'Create workspace' : 'Sign in'}<ArrowRight size={16} /></button></form>
      <p class="auth-disclaimer">Demo ships and disruptions are simulated. No live vessel positions or carrier feeds are connected.</p></div></section></main>;
}

const invitationCopy = (invitation: Invitation): Readonly<{ title: string; detail: string }> => {
  switch (invitation.delivery) {
    case 'accepted': return { title: 'Invitation email submitted', detail: `The email provider accepted the invitation for ${invitation.email}. Inbox delivery is not confirmed.` };
    case 'unconfirmed': return { title: 'Email delivery unconfirmed', detail: `${invitation.warning} Share this link with ${invitation.email}; they must sign in with that address.` };
    case 'link-only': return { title: 'Invitation ready — email not sent', detail: `Share this link with ${invitation.email}. They must sign in with that email to join.` };
  }
};

function TeamPanel(props: Readonly<{ workspace: Workspace; open: boolean; onClose: () => void }>) {
  const [members] = createResource(() => props.workspace.id, async id => { const result = await request(`/api/workspaces/${id}/members`, membersSchema); return result.ok ? { members: result.value.members } : { members: [], error: result.error }; });
  const [invitation, setInvitation] = createSignal<Invitation | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  async function invite(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault(); const email = textField(new FormData(event.currentTarget), 'email'); setBusy(true); setError(null); setInvitation(null);
    const result = await request(`/api/workspaces/${props.workspace.id}/invitations`, invitationSchema, { email }); setBusy(false);
    if (result.ok) setInvitation(result.value); else setError(result.error);
  }
  const shown = () => error() ?? (members()?.members.length === 0 ? (members() as { error?: string } | undefined)?.error ?? null : null);
  return <Dialog.Root open={props.open} onOpenChange={details => { if (!details.open) props.onClose(); }} lazyMount unmountOnExit>
    <Portal><Dialog.Backdrop class="modal-dim" /><Dialog.Positioner class="modal-backdrop"><Dialog.Content class="team-dialog">
      <Dialog.CloseTrigger class="icon-button dialog-close" aria-label="Close team settings"><X size={20} /></Dialog.CloseTrigger><span class="section-kicker">SHARED WORKSPACE</span><Dialog.Title>Your team, in sync.</Dialog.Title><Dialog.Description>Members share ships, updates and comments in <strong>{props.workspace.name}</strong>.</Dialog.Description>
      <div class="member-list"><For each={members()?.members ?? []}>{member => <div class="member"><span class="avatar">{member.name.slice(0, 1).toUpperCase()}</span><div><strong>{member.name}</strong><small>{member.email}</small></div><span class="member-role">{member.role}</span></div>}</For></div>
      <Show when={props.workspace.role === 'owner'} fallback={<p class="muted">Only the workspace owner can invite teammates.</p>}><form onSubmit={invite}><label>Invite by email<input type="email" name="email" placeholder="teammate@company.com" required /></label><button class="primary full" disabled={busy()}><Plus size={16} />{busy() ? 'Creating invitation…' : 'Invite teammate'}</button></form></Show>
      <Show when={shown()}>{message => <ErrorNote message={message()} />}</Show>
      <Show when={invitation()}>{item => <div class="invitation-result"><strong>{invitationCopy(item()).title}</strong><p>{invitationCopy(item()).detail}</p><label>Invitation link<input readOnly value={item().url} onFocus={event => event.currentTarget.select()} /></label></div>}</Show>
    </Dialog.Content></Dialog.Positioner></Portal>
  </Dialog.Root>;
}

function ShipmentDetails(props: Readonly<{ shipmentId: string; dashboard: Dashboard; workspaceId: string; live: boolean; incoming: readonly CommentEvent[] }>) {
  const [comments, setComments] = createSignal<readonly Comment[]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [loadError, setLoadError] = createSignal<string | null>(null);
  const [sending, setSending] = createSignal(false);
  const path = `/api/workspaces/${props.workspaceId}/shipments/${props.shipmentId}/comments`;
  createEffect(() => {
    if (sending()) return;
    const live = props.live;
    const controller = new AbortController();
    let timer: number | undefined;
    const load = (): Promise<void> => controller.signal.aborted ? Promise.resolve() : request(path, commentsSchema, undefined, controller.signal).then(result => { if (!controller.signal.aborted) { if (result.ok) { setComments(result.value.comments); setLoadError(null); } else setLoadError(result.error); if (!live) timer = window.setTimeout(() => { void load(); }, 5000); } });
    void load();
    onCleanup(() => { controller.abort(); window.clearTimeout(timer); });
  });
  createEffect(() => {
    const fresh = props.incoming.filter(event => event.shipmentId === props.shipmentId);
    if (fresh.length > 0) setComments(current => fresh.reduce((merged, event) => mergeComment(merged, event.comment), current));
  });
  const shipment = createMemo(() => props.dashboard.shipments.find(item => item.id === props.shipmentId));
  const etaFlash = createChangeFlash(() => minute(shipment()?.eta));
  const changeFlash = createChangeFlash(() => shipment()?.change ?? '');
  async function comment(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
    event.preventDefault(); const form = event.currentTarget; const body = textField(new FormData(form), 'body'); setSending(true); setError(null);
    const result = await request(path, commentsSchema, { body }); setSending(false);
    if (result.ok) { setComments(result.value.comments); form.reset(); } else setError(result.error);
  }
  const flashing = () => changeFlash() || etaFlash();
  return <Show when={shipment()}>{current => { const s = current; return <aside class="detail-panel" id="shipment-details" aria-label={`Details for ${s().vessel}`}>
    <div class="detail-title"><div><span class="section-kicker">SHIP DETAILS</span><h2>{s().vessel}</h2><span class="reference">{s().agent}, mind aboard · {s().reference}</span></div><span class="detail-ship"><Ship size={24} stroke-width={1.4} /></span></div>
    <div class="detail-route"><span>{portName(props.dashboard.ports, s().origin)}</span><ArrowRight size={15} /><span>{portName(props.dashboard.ports, s().destination)}</span></div><div class="cargo-line">{s().cargo}<span>·</span>{s().containers} containers</div>
    <section class="eta-card" classList={{ flash: etaFlash() }}><div class="eta-heading"><span>CURRENT ETA</span><RiskBadge risk={s().risk} /></div><div class="eta-date">{date(s().eta)}<small>{time(s().eta)} UTC</small></div><div class="eta-delta" classList={{ changed: s().delayHours > 0 }}><Show when={s().delayHours > 0} fallback={<><Check size={14} />No change to arrival schedule</>}><ArrowDownRight size={15} />+{s().delayHours}h from original schedule<span>Was {date(s().baselineEta)}</span></Show></div></section>
    <section class="detail-section what-changed" classList={{ flash: flashing() }}><h3>{shipmentBrief(s()).source}<Show when={flashing()}><span class="live-chip">UPDATED</span></Show></h3><p>{shipmentBrief(s()).text}</p><p class="assessment-note">{assessmentFor(s())?.method === 'ai-assessed' ? `AI model: ${assessmentFor(s())?.model}. Based on cited evidence.` : s().voyage ? 'Voyage plan supplied by an operator. Positions and scenario assessments are simulated.' : 'Scenario assessment. Live notices may not yet be reflected in this estimate.'}</p><Show when={s().action}>{action => <div class="action-box"><TriangleAlert size={16} /><div><strong>Action needed</strong><p>{action()}</p></div></div>}</Show></section>
    <section class="detail-section"><h3>Route milestones</h3><ol class="milestones"><For each={s().milestones}>{milestone => <li class={milestone.status}><span class="milestone-node"><Show when={milestone.status === 'complete'}><Check size={10} /></Show></span><div><strong>{milestone.label}</strong><small>{date(milestone.at)} · {time(milestone.at)} UTC</small></div><Show when={milestone.status === 'current'}><span class="current-label">CURRENT</span></Show></li>}</For></ol></section>
    <section class="detail-section"><h3>Supporting evidence</h3><Show when={s().evidence.length > 0} fallback={<p class="muted">No supporting evidence has been attached to this ship.</p>}><For each={s().evidence}>{evidence => <EvidenceCard evidence={evidence} />}</For></Show></section>
    <section class="detail-section comments"><h3><MessageSquare size={15} />Team notes<span class="note-count">{comments().length}</span></h3><Show when={comments().length === 0}><p class="muted">Keep the next handoff in view. Add a note for your team.</p></Show><For each={comments()}>{item => <article class="comment"><div><strong>{item.author}</strong><small>{date(item.createdAt)}, {time(item.createdAt)}</small></div><p>{item.body}</p></article>}</For><form onSubmit={comment}><label class="sr-only" for="comment-body">Add a team note</label><textarea id="comment-body" name="body" placeholder="Add a note for your team…" maxLength={4000} required rows={2} /><button class="text-button" disabled={sending()}>{sending() ? 'Posting…' : 'Post note'}<Send size={13} /></button></form><Show when={error() ?? loadError()}>{message => <ErrorNote message={message()} />}</Show></section>
  </aside>; }}</Show>;
}

function ShipmentCard(props: Readonly<{ shipment: Shipment; selected: boolean; onSelect: (id: string) => void }>) {
  const flash = createChangeFlash(() => minute(props.shipment.eta));
  return <button class="shipment-card" classList={{ selected: props.selected, flash: flash() }} onClick={() => props.onSelect(props.shipment.id)} aria-pressed={props.selected}><span class={`fleet-pixel ${props.shipment.risk}`}><PixelShip /></span><span class="fleet-identity"><strong>{props.shipment.vessel}</strong><span class="fleet-risk-line"><RiskBadge risk={props.shipment.risk} /><Show when={props.shipment.delayHours > 0}><span class="delay">· +{props.shipment.delayHours}h</span></Show></span></span><Show when={props.shipment.risk !== 'on-track'}><span class={`fleet-alert ${props.shipment.risk}`} aria-hidden="true">{props.shipment.risk === 'watch' ? '△' : '!'}</span></Show></button>;
}

function WorkspaceOperations(props: Readonly<{ workspaceId: string }>) {
  const [simulation, setSimulation] = createSignal<SimulationResult | null>(null);
  const [editing, setEditing] = createSignal<Shipment | 'new' | null>(null);
  const [operating, setOperating] = createSignal(false);
  const [operationError, setOperationError] = createSignal<string | null>(null);
  const feed = createWorkspaceFeed(props.workspaceId, () => false);
  const dashboard = feed.dashboard;
  const [view, setView] = createSignal<View>(readView(window.location.hash, props.workspaceId));
  const [selectedId, setSelectedId] = createSignal<string | null>(null, { equals: false });
  const [inspected, setInspected] = createSignal<Diversion | null>(null);
  const [query, setQuery] = createSignal('');
  const [threadId, setThreadId] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [returnRoute, setReturnRoute] = createSignal<string | null>(null);
  let detailHeading: HTMLHeadingElement | undefined;
  const sync = () => { const next = readView(window.location.hash, props.workspaceId); setView(next); setInspected(null); if (next.kind === 'voyage') setSelectedId(next.id); const anchor = next.kind === 'shipments' ? window.location.hash.slice(1) : ''; if (anchor) window.setTimeout(() => document.getElementById(anchor)?.scrollIntoView(), 0); };
  window.addEventListener('hashchange', sync);
  onCleanup(() => window.removeEventListener('hashchange', sync));
  function navigate(next: View) {
    const hash = viewHash(next, props.workspaceId);
    window.history.pushState(null, '', window.location.pathname + window.location.search + hash);
    setView(next); setInspected(null); setQuery('');
    if (next.kind === 'voyage') setSelectedId(next.id);
    window.setTimeout(() => detailHeading?.focus(), 0);
  }
  function openRoute(id: string) { setSelectedId(null); setReturnRoute(null); navigate({ kind: 'route', id }); }
  function openVoyage(id: string) { const current = view(); setReturnRoute(current.kind === 'route' ? current.id : null); navigate({ kind: 'voyage', id }); }
  function closeDetail() { const current = view(); navigate(current.kind === 'voyage' && returnRoute() ? { kind: 'route', id: returnRoute()! } : { kind: current.kind === 'route' ? 'routes' : 'shipments' }); }
  const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName)) { if (inspected()) setInspected(null); else if (view().kind === 'voyage' || view().kind === 'route') closeDetail(); else setSelectedId(null); } };
  window.addEventListener('keydown', escape); onCleanup(() => window.removeEventListener('keydown', escape));
  const route = createMemo(() => { const current = view(); return current.kind === 'route' ? dashboard()?.routes?.find(r => r.id === current.id) : undefined; });
  const detail = () => view().kind === 'route' || view().kind === 'voyage';
  const feedPage = () => view().kind === 'news' || view().kind === 'activity' || view().kind === 'alerts' || view().kind === 'simulation';
  const routesMode = () => view().kind === 'routes' || view().kind === 'route';
  const routes = createMemo(() => dashboard()?.routes?.filter(r => routeName(r, dashboard()!).toLowerCase().includes(query().trim().toLowerCase())).toSorted((left, right) => right.attention - left.attention) ?? []);
  const riskOrder: Readonly<Record<Shipment['risk'], number>> = { delayed: 0, watch: 1, 'on-track': 2 };
  const fleet = createMemo(() => dashboard()?.shipments.toSorted((left, right) => riskOrder[left.risk] - riskOrder[right.risk] || left.vessel.localeCompare(right.vessel)) ?? []);
  const selected = createMemo(() => { const current = view(); return dashboard()?.shipments.find(shipment => shipment.id === (current.kind === 'voyage' ? current.id : selectedId())) ?? (current.kind === 'voyage' ? undefined : fleet()[0]); });
  const shipments = createMemo(() => fleet().filter(s => `${s.vessel} ${s.identity?.imo ?? ''} ${s.identity?.mmsi ?? ''} ${s.reference} ${s.cargo} ${dashboard()?.ports.find(p => p.id === s.origin)?.name} ${dashboard()?.ports.find(p => p.id === s.destination)?.name}`.toLowerCase().includes(query().trim().toLowerCase())));
  const counts = createMemo(() => ({ delayed: fleet().filter(ship => ship.risk === 'delayed').length, watch: fleet().filter(ship => ship.risk === 'watch').length, onTrack: fleet().filter(ship => ship.risk === 'on-track').length }));
  const failure = () => error() ?? feed.error();
  const mapDashboard = createMemo(() => { const current = dashboard(); const focused = route(); return current && focused ? { ...current, shipments: current.shipments.filter(s => focused.shipmentIds.includes(s.id)), ports: current.ports.filter(p => focused.endpoints.includes(p.id)), intelligence: focused.intelligence } : current; });
  function selectShip(id: string) { setSelectedId(id); setInspected(null); if (view().kind === 'voyage') openVoyage(id); }
  const notifications = createAlertNotifications(props.workspaceId, dashboard, openVoyage);
  function edit(ship: Shipment | 'new') { setOperationError(null); setEditing(ship); }
  async function operate(operation: Operation): Promise<boolean> {
    setOperating(true); setOperationError(null);
    const result = await request(`/api/workspaces/${props.workspaceId}/operations`, dashboardSchema, operation);
    setOperating(false);
    if (!result.ok) { setOperationError(result.error); return false; }
    feed.accept(result.value);
    if (operation.action === 'remove') { setSelectedId(null); navigate({ kind: 'shipments' }); }
    return true;
  }
  return <>
    <div class="simulation-banner"><span><span class="simulation-light" />{dashboard()?.mode === 'simulation' ? 'Simulated sources' : dashboard() ? 'Mixed-source workspace' : 'Connecting to workspace'}<span class="banner-separator">/</span>{dashboard()?.mode === 'simulation' ? 'Current notices are simulated. No live tracking is implied.' : 'Source provenance is shown on each evidence item.'}</span><span class="banner-scope">ALL TIMES UTC</span></div>
    <Show when={failure()}>{message => <div class="global-error"><ErrorNote message={message()} /><button type="button" class="retry-button" onClick={() => { setError(null); feed.retry(); }}>Retry</button></div>}</Show>
    <Show when={editing()} keyed>{item => <Show when={dashboard()}>{current => <VesselEditor shipment={item === 'new' ? undefined : item} dashboard={current()} busy={operating()} error={operationError()} execute={operate} close={() => setEditing(null)} />}</Show>}</Show>
    <Show when={view().kind === 'alerts'}><AlertsPage dashboard={dashboard()} busy={operating()} error={operationError()} execute={operate} openVoyage={openVoyage} notifications={notifications} /></Show>
    <Show when={view().kind === 'simulation'}><SimulationPage dashboard={dashboard()} result={simulation()} onResult={setSimulation} /></Show>
    <Show when={view().kind === 'news'}><NewsPage dashboard={dashboard()} onInspect={option => { openVoyage(option.shipmentId); setInspected(option); }} /></Show>
    <Show when={view().kind === 'activity'}><div class="activity-page"><details class="activity-evidence"><summary>Port risk & attributed evidence chains</summary><Show when={dashboard()}>{current => <SocietyPanel dashboard={current()} onSelectShip={openVoyage} threadId={threadId()} onOpenMessage={setThreadId} />}</Show></details><AgentBoard dashboard={dashboard()} connection={feed.mode()} /></div></Show>
    <Show when={!feedPage()}>
    <Show when={detail()}><header class="voyage-header"><button class="back-overview" onClick={closeDetail}>← {view().kind === 'route' ? 'All routes' : returnRoute() ? 'Back to route' : 'All shipments'}</button><div><h1 ref={detailHeading} tabIndex={-1}>{route() && dashboard() ? routeName(route()!, dashboard()!) : selected()?.vessel ?? 'Loading briefing…'}</h1><p>{view().kind === 'route' ? 'Route monitoring · approximate port-to-port corridor' : `${selected()?.reference ?? ''} · Voyage briefing`}</p></div><Show when={route()?.risk ?? selected()?.risk}>{risk => <RiskBadge risk={risk()} />}</Show></header></Show>
    <main class={`operations-layout${detail() ? ' drilldown-layout' : ''}`}><Show when={!detail()}><aside class="shipments-panel" id="workspace-shipments"><div class="shipments-heading"><span class="section-kicker">YOUR OPERATIONS</span><h1>{routesMode() ? 'Routes' : 'Fleet'}<span>{routesMode() ? dashboard()?.routes?.length ?? '—' : dashboard()?.shipments.length ?? '—'}</span></h1><p>{routesMode() ? 'Watch shared exposure across voyages.' : 'Risk first. Every voyage in view.'}</p><Show when={!routesMode()}><button type="button" class="fleet-add" onClick={() => edit('new')} disabled={!dashboard()}><Plus size={14} />Add vessel</button></Show><nav class="workspace-jump" aria-label="Workspace sections"><a href="#workspace-ports">Ports</a><a href="#actor-board">Actor board</a></nav></div><div class="shipment-search"><Search size={15} /><label class="sr-only" for="search">{routesMode() ? 'Search routes' : 'Search ships'}</label><input id="search" value={query()} onInput={event => setQuery(event.currentTarget.value)} placeholder={routesMode() ? 'Search by port' : 'Find a ship, port or IMO'} /></div>
      <Show when={!routesMode()}><div class="fleet-scope"><Show when={dashboard()} fallback={<span>Connecting to fleet</span>}><span>{counts().delayed} delayed · {counts().watch} watch · {counts().onTrack} on track</span></Show><Show when={query()}><button type="button" onClick={() => setQuery('')}>Show all {fleet().length} ships</button></Show></div></Show>
      <div class="shipment-list"><Show when={!dashboard()}><div class="empty-state"><Radio size={22} /><p>{failure() ? 'Ship updates unavailable.' : 'Loading your ships…'}</p></div></Show><Show when={dashboard() && !(routesMode() ? routes().length : shipments().length)}><div class="empty-state"><Check size={22} /><p>No matches for your search.</p></div></Show><Show when={routesMode()} fallback={<For each={shipments()}>{shipment => <ShipmentCard shipment={shipment} selected={selected()?.id === shipment.id} onSelect={selectShip} />}</For>}><For each={routes()}>{r => <RouteCard route={r} dashboard={dashboard()!} onOpen={openRoute} />}</For></Show></div>
      <footer class="list-footer"><span class={`status-dot ${feed.mode()}`} /><span>{dashboard() ? `Updated ${time(dashboard()?.updatedAt ?? '')} UTC` : 'Connecting to workspace'}</span><span class={`feed-mode ${feed.mode()}`}>{feedLabel[feed.mode()]}</span></footer></aside></Show>
      <section class="world-panel" id="world" aria-label="World"><div class="world-health"><Show when={dashboard()?.operations?.alerts.filter(alert => !alert.acknowledgedAt).length}>{unread => <a class="alert-count" href={viewHash({ kind: 'alerts' }, props.workspaceId)}><Bell size={12} />{unread()} unread {unread() === 1 ? 'alert' : 'alerts'}</a>}</Show><Show when={dashboard()?.relayHealth}>{health => <span class={`relay-health ${health().state}`}>Relay {health().state}<Show when={health().since}>{since => <> since {time(since())} UTC</>}</Show></span>}</Show><Show when={dashboard()?.startup && dashboard()?.startup?.ready !== dashboard()?.startup?.total}><span>Agents joining · {dashboard()?.startup?.ready}/{dashboard()?.startup?.total}</span></Show></div><section class="map-panel" aria-label={routesMode() ? 'Route overview map' : 'Ship overview map'}><ShipmentMap dashboard={mapDashboard()} selected={selected()} focusId={view().kind === 'voyage' ? selected()?.id ?? null : selectedId()} onSelect={selectShip} onOpen={() => { const ship = selected(); if (ship) openVoyage(ship.id); }} onDismiss={() => setSelectedId(null)} inspected={inspected()} corridor={route()} routeMode={routesMode()} onRoute={openRoute} showPopup={Boolean(selectedId()) && view().kind !== 'voyage' && !inspected()} /><Show when={selected() && view().kind !== 'voyage'}><button type="button" class="selected-voyage-link" onClick={() => { const ship = selected(); if (ship) openVoyage(ship.id); }}>Open {selected()?.vessel} briefing<ArrowRight size={14} /></button></Show></section></section>
      <Show when={!detail() && dashboard()}>{_ => <ActorLine dashboard={dashboard()!} onOpenMessage={setThreadId} />}</Show>
      <Show when={dashboard()}>{current => <>
        <Show when={!detail() && selected()?.id} keyed>{id => <ShipmentDetails shipmentId={id} dashboard={current()} workspaceId={props.workspaceId} live={feed.mode() === 'live'} incoming={feed.comments()} />}</Show>
        <Show when={view().kind === 'voyage' && selected()?.id} keyed>{id => <div class="voyage-detail-column"><Show when={selected()}>{ship => <VoyageFacts shipment={ship()} dashboard={current()} edit={() => edit(ship())} />}</Show><div class="voyage-route-links"><span class="section-kicker">MONITORED ROUTE LEGS</span><For each={current().routes?.filter(r => r.shipmentIds.includes(id))}>{r => <button onClick={() => openRoute(r.id)}>{routeName(r, current())}<ArrowRight size={13} /></button>}</For></div><ShipmentDetails shipmentId={id} dashboard={current()} workspaceId={props.workspaceId} live={feed.mode() === 'live'} incoming={feed.comments()} /></div>}</Show>
        <Show when={route()}>{r => <RouteDetails route={r()} dashboard={current()} onVoyage={openVoyage} />}</Show>
        <Show when={detail() && !(route() || selected())}><aside class="detail-panel"><h2>Briefing unavailable</h2><p>This item is not in this workspace.</p><button onClick={closeDetail}>Return to monitoring</button></aside></Show>
      </>}</Show>
    </main>
    <Show when={dashboard()}>{current => <SocietyPanel dashboard={current()} onSelectShip={setSelectedId} threadId={threadId()} onOpenMessage={setThreadId} />}</Show>
    </Show>
  </>;
}

function WorkspaceScreen(props: Readonly<{ session: Session; demo: boolean; onOpenDemo: () => void; onLogout: () => void; onSession: (session: Session) => void }>) {
  const [workspaceId, setWorkspaceId] = createSignal(props.session.workspaces[0]?.id ?? '');
  const [teamOpen, setTeamOpen] = createSignal(false);
  const [accepting, setAccepting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [inviteToken, setInviteToken] = createSignal(new URLSearchParams(window.location.search).get('invite'));
  const workspace = createMemo(() => props.session.workspaces.find(item => item.id === workspaceId()));
  function clearInvitation() {
    setInviteToken(null); setError(null);
    window.history.replaceState(null, '', window.location.pathname);
  }
  async function acceptInvitation() {
    setAccepting(true); setError(null);
    const result = await request('/api/invitations/accept', workspaceSchema, { token: inviteToken() });
    setAccepting(false);
    if (result.ok) { props.onSession({ ...props.session, workspaces: [...props.session.workspaces.filter(item => item.id !== result.value.id), result.value] }); setWorkspaceId(result.value.id); setTeamOpen(false); clearInvitation(); } else setError(result.error);
  }
  return <div class="workspace-shell"><header class="topbar"><Brand /><nav class="primary-nav" aria-label="Primary"><a href="#world">World</a><a href={viewHash({ kind: 'routes' }, workspaceId())}>Routes</a><a href={viewHash({ kind: 'news' }, workspaceId())}>Intelligence</a><a href={viewHash({ kind: 'activity' }, workspaceId())}>Agents</a><a href={viewHash({ kind: 'alerts' }, workspaceId())}>Alerts</a><a href="#actor-board">Relay</a><a href={viewHash({ kind: 'simulation' }, workspaceId())}>Simulation</a></nav><div class="workspace-picker"><Layers3 size={15} /><label class="sr-only" for="workspace">Workspace</label><select id="workspace" value={workspaceId()} onChange={event => { setWorkspaceId(event.currentTarget.value); setTeamOpen(false); }}><For each={props.session.workspaces}>{item => <option value={item.id}>{item.name}</option>}</For></select><ChevronDown size={13} /></div><div class="topbar-right"><span class="demo-tag"><Users size={12} /> SHARED WORKSPACE</span><button class="team-button" onClick={() => setTeamOpen(true)} disabled={!workspace()}><Users size={15} />Team</button><Menu.Root positioning={{ placement: 'bottom-end' }} onSelect={details => { if (details.value === 'demo') props.onOpenDemo(); }}><Menu.Trigger class="avatar avatar-menu" title={props.session.user.email} aria-label={`Account menu for ${props.session.user.email}`}>{props.session.user.name.slice(0, 1).toUpperCase()}</Menu.Trigger><Portal><Menu.Positioner><Menu.Content class="account-menu"><div class="account-menu-who"><strong>{props.session.user.name}</strong><small>{props.session.user.email}</small></div><Show when={props.demo && props.session.user.email !== DEMO_EMAIL}><Menu.Item value="demo" class="account-menu-item"><FlaskConical size={15} />Open demo workspace</Menu.Item></Show><Menu.Item value="signout" class="account-menu-item" onSelect={props.onLogout}><LogOut size={15} />Sign out</Menu.Item></Menu.Content></Menu.Positioner></Portal></Menu.Root><button class="icon-button" onClick={props.onLogout} aria-label="Sign out"><LogOut size={16} /></button></div></header>
    <Show when={inviteToken()}><div class="invite-banner"><span><Users size={16} />You have a workspace invitation. Signed in as {props.session.user.email}.</span><div class="invite-actions"><button disabled={accepting()} onClick={() => { void acceptInvitation(); }}>{accepting() ? 'Joining…' : 'Accept invitation'}<ArrowRight size={14} /></button><button disabled={accepting()} onClick={clearInvitation}>Use my workspace instead</button></div></div></Show>
    <Show when={error()}>{message => <div class="global-error"><ErrorNote message={message()} /></div>}</Show>
    <Show when={!inviteToken() ? workspace()?.id : undefined} keyed>{id => <WorkspaceOperations workspaceId={id} />}</Show>
    <Show when={workspace()} keyed>{item => <TeamPanel workspace={item} open={teamOpen()} onClose={() => setTeamOpen(false)} />}</Show></div>;
}

function App() {
  const [session, setSession] = createSignal<Session | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [initialError, setInitialError] = createSignal<string | null>(null);
  const [demo, setDemo] = createSignal(false);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const demoPath = window.location.pathname.replace(/\/+$/, '') === '/demo';
  void (async () => {
    const found = await request('/api/session', sessionSchema, undefined, controller.signal);
    if (controller.signal.aborted) return;
    if (!found.ok && found.status !== 401) { setInitialError(found.error); setLoading(false); return; }
    const offer = await request('/api/demo-session', z.object({ available: z.boolean() }), undefined, controller.signal);
    if (controller.signal.aborted) return;
    const available = offer.ok && offer.value.available;
    setDemo(available);
    let current = found.ok ? found.value : null;
    if (demoPath) {
      window.history.replaceState(null, '', '/');
      if (!available) setInitialError('The demo workspace is not available on this server.');
      else {
        if (current && current.user.email !== DEMO_EMAIL) { await request('/api/logout', z.unknown(), {}); current = null; }
        const failed = await enterDemo(next => { current = next; });
        if (failed) setInitialError(failed);
      }
    } else if (!current && available && !window.sessionStorage.getItem(DECLINED_DEMO)) {
      const failed = await enterDemo(next => { current = next; });
      if (failed) setInitialError(failed);
    }
    if (controller.signal.aborted) return;
    setSession(current);
    setLoading(false);
  })();
  async function openDemo() {
    await request('/api/logout', z.unknown(), {});
    const failed = await enterDemo(setSession);
    if (failed) { setSession(null); setInitialError(failed); }
  }
  async function logout() { const result = await request('/api/logout', z.unknown(), {}); if (result.ok) { window.sessionStorage.setItem(DECLINED_DEMO, '1'); setSession(null); } else window.alert(result.error); }
  return <Show when={!loading()} fallback={<div class="loading-screen"><Brand /><span>Opening your workspace…</span></div>}>
    <Show when={session()?.user.id} keyed fallback={<><Show when={initialError()}>{message => <div class="initial-error"><ErrorNote message={message()} /></div>}</Show><Authentication onSession={setSession} demo={demo()} /></>}>{userId => <Show when={session()}>{current => <WorkspaceScreen session={current()} demo={demo()} onOpenDemo={() => { void openDemo(); }} onSession={setSession} onLogout={() => { void logout(); }} />}</Show>}</Show>
  </Show>;
}

const root = document.getElementById('root');
if (root) render(() => <App />, root);
