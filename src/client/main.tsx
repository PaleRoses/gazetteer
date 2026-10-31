import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show, type JSX } from 'solid-js';
import { render, Portal } from 'solid-js/web';
import { Dialog, Tabs } from '@ark-ui/solid';
import { Anchor, ArrowDownRight, ArrowRight, Check, ChevronDown, Compass, FlaskConical, Layers3, LogOut, MapPin, MessageSquare, Plus, Radio, Search, Send, Ship, TriangleAlert, Users, X } from 'lucide-solid';
import { z } from 'zod';
import type { Comment, Dashboard, Shipment, Workspace } from '../shared';
import { commentsSchema, dashboardSchema, invitationSchema, membersSchema, request, sessionSchema, workspaceSchema, type Invitation, type Session } from './api';
import { MapBackdrop, ShipmentMap } from './Map';
import { mergeComment, type CommentEvent } from './feed';
import { createChangeFlash, createWorkspaceFeed, type FeedMode } from './live';
import './styles.css';

const date = (value: string): string => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const time = (value: string): string => new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const minute = (eta: string | undefined): string => (eta ?? '').slice(0, 16);
const feedLabel: Readonly<Record<FeedMode, string>> = { connecting: 'CONNECTING', live: 'LIVE', polling: 'POLLING · 5 S' };
const riskLabel = { 'on-track': 'On schedule', watch: 'Watch', delayed: 'Delayed' };
const textField = (data: FormData, key: string): string => { const value = data.get(key); return typeof value === 'string' ? value : ''; };
const ErrorNote = (props: Readonly<{ message: string }>) => <p class="error-note" role="alert"><TriangleAlert size={15} />{props.message}</p>;

function Brand() { return <a class="brand" href="/" aria-label="Gazetteer home"><span class="brand-mark"><Compass size={25} stroke-width={1.5} /></span>Gazetteer<span class="brand-dot">.</span></a>; }
function RiskBadge(props: Readonly<{ risk: Shipment['risk'] }>) { return <span class={`risk-badge ${props.risk}`}><Show when={props.risk !== 'on-track'} fallback={<span class="status-dot" />}><TriangleAlert size={11} /></Show>{riskLabel[props.risk]}</span>; }

function Authentication(props: Readonly<{ onSession: (session: Session) => void }>) {
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
  return <main class="auth-shell"><section class="auth-story"><Brand /><div class="auth-map"><MapBackdrop /></div><div class="auth-copy"><span class="eyebrow"><Radio size={14} /> A SHARED VIEW OF WHAT'S NEXT</span><h1>Cargo moves.<br />Stay ahead.</h1><p>Your shipments, their arrival times, and the changes that matter. All in one shared workspace.</p><div class="auth-features"><span><MapPin size={16} />Follow every shipment</span><span><TriangleAlert size={16} />See what needs attention</span><span><Users size={16} />Make the next call together</span></div></div><div class="auth-foot"><span>GAZETTEER / OPERATIONS</span><span>Clarity from origin to destination.</span></div></section>
    <section class="auth-panel"><div class="auth-form-wrap"><span class="demo-tag"><FlaskConical size={13} /> SYNTHETIC DEMO</span><h2>{invited ? 'Join your team.' : signup() ? 'Your next clear view.' : 'Welcome back.'}</h2><p>{invited ? 'Sign in with your invited email, then accept your workspace invitation.' : signup() ? 'Create an account to explore your shared shipment workspace.' : 'Sign in to pick up where your team left off.'}</p>
      <Tabs.Root value={mode()} onValueChange={details => { setMode(details.value === 'login' ? 'login' : 'signup'); setError(null); }}><Tabs.List class="auth-tabs"><Tabs.Trigger value="signup">Create account</Tabs.Trigger><Tabs.Trigger value="login">Sign in</Tabs.Trigger></Tabs.List></Tabs.Root>
      <form onSubmit={submit}><Show when={signup()}><label>Your name<input name="name" autocomplete="name" maxLength={80} required placeholder="Alex Morgan" /></label></Show><label>Email<input name="email" type="email" autocomplete="email" required placeholder="you@company.com" /></label><label>Password<input name="password" type="password" autocomplete={signup() ? 'new-password' : 'current-password'} minLength={12} required placeholder="At least 12 characters" /></label><Show when={signup()}><label>Workspace name <span class="optional">optional</span><input name="workspaceName" maxLength={100} placeholder="Your logistics team" /></label></Show><Show when={error()}>{message => <ErrorNote message={message()} />}</Show><button class="primary full" disabled={busy()}>{busy() ? 'Connecting…' : signup() ? 'Create workspace' : 'Sign in'}<ArrowRight size={16} /></button></form>
      <p class="auth-disclaimer">Demo shipments and disruptions are simulated. No live vessel positions or carrier feeds are connected.</p></div></section></main>;
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
      <Dialog.CloseTrigger class="icon-button dialog-close" aria-label="Close team settings"><X size={20} /></Dialog.CloseTrigger><span class="section-kicker">SHARED WORKSPACE</span><Dialog.Title>Your team, in sync.</Dialog.Title><Dialog.Description>Members share shipments, updates and comments in <strong>{props.workspace.name}</strong>.</Dialog.Description>
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
  const portName = (id: string): string => props.dashboard.ports.find(port => port.id === id)?.name ?? id;
  const flashing = () => changeFlash() || etaFlash();
  return <Show when={shipment()}>{current => { const s = current; return <aside class="detail-panel" aria-label={`Details for ${s().vessel}`}>
    <div class="detail-title"><div><span class="section-kicker">SHIPMENT DETAILS</span><h2>{s().vessel}</h2><span class="reference">{s().reference}</span></div><span class="detail-ship"><Ship size={24} stroke-width={1.4} /></span></div>
    <div class="detail-route"><span>{portName(s().origin)}</span><ArrowRight size={15} /><span>{portName(s().destination)}</span></div><div class="cargo-line">{s().cargo}<span>·</span>{s().containers} containers</div>
    <section class="eta-card" classList={{ flash: etaFlash() }}><div class="eta-heading"><span>CURRENT ETA</span><RiskBadge risk={s().risk} /></div><div class="eta-date">{date(s().eta)}<small>{time(s().eta)} UTC</small></div><div class="eta-delta" classList={{ changed: s().delayHours > 0 }}><Show when={s().delayHours > 0} fallback={<><Check size={14} />No change to arrival schedule</>}><ArrowDownRight size={15} />+{s().delayHours}h from original schedule<span>Was {date(s().baselineEta)}</span></Show></div></section>
    <section class="detail-section what-changed" classList={{ flash: flashing() }}><h3>What changed<Show when={flashing()}><span class="live-chip">UPDATED</span></Show></h3><p>{s().change}</p><Show when={s().action}>{action => <div class="action-box"><TriangleAlert size={16} /><div><strong>Action needed</strong><p>{action()}</p></div></div>}</Show></section>
    <section class="detail-section"><h3>Route milestones</h3><ol class="milestones"><For each={s().milestones}>{milestone => <li class={milestone.status}><span class="milestone-node"><Show when={milestone.status === 'complete'}><Check size={10} /></Show></span><div><strong>{milestone.label}</strong><small>{date(milestone.at)} · {time(milestone.at)} UTC</small></div><Show when={milestone.status === 'current'}><span class="current-label">CURRENT</span></Show></li>}</For></ol></section>
    <section class="detail-section"><h3>Supporting evidence<span class="mini-sim">{[...new Set(s().evidence.map(item => item.source === 'live' ? 'LIVE' : 'SIMULATED'))].join(' + ') || 'SIMULATED'}</span></h3><Show when={s().evidence.length > 0} fallback={<p class="muted">No disruption reported in this demo.</p>}><For each={s().evidence}>{evidence => <article class="evidence"><div><Show when={evidence.source === 'live'} fallback={<FlaskConical size={14} />}><Radio size={14} /></Show><strong>{evidence.title}</strong></div><p>{evidence.detail}</p><small>{evidence.source === 'live' ? <>Live · <a href={evidence.url} target="_blank" rel="noreferrer">{evidence.provider}</a></> : 'Scenario source'} · {date(evidence.observedAt)}, {time(evidence.observedAt)} UTC</small></article>}</For></Show></section>
    <section class="detail-section comments"><h3><MessageSquare size={15} />Team notes<span class="note-count">{comments().length}</span></h3><Show when={comments().length === 0}><p class="muted">Keep the next handoff in view. Add a note for your team.</p></Show><For each={comments()}>{item => <article class="comment"><div><strong>{item.author}</strong><small>{date(item.createdAt)}, {time(item.createdAt)}</small></div><p>{item.body}</p></article>}</For><form onSubmit={comment}><label class="sr-only" for="comment-body">Add a team note</label><textarea id="comment-body" name="body" placeholder="Add a note for your team…" maxLength={4000} required rows={2} /><button class="text-button" disabled={sending()}>{sending() ? 'Posting…' : 'Post note'}<Send size={13} /></button></form><Show when={error() ?? loadError()}>{message => <ErrorNote message={message()} />}</Show></section>
  </aside>; }}</Show>;
}

function ShipmentCard(props: Readonly<{ shipment: Shipment; ports: Dashboard['ports']; selected: boolean; onSelect: (id: string) => void }>) {
  const flash = createChangeFlash(() => minute(props.shipment.eta));
  const portName = (id: string): string | undefined => props.ports.find(port => port.id === id)?.name;
  return <button class="shipment-card" classList={{ selected: props.selected, flash: flash() }} onClick={() => props.onSelect(props.shipment.id)} aria-pressed={props.selected}><div class="shipment-card-top"><span class="small-ship"><Ship size={17} /></span><RiskBadge risk={props.shipment.risk} /></div><h2>{props.shipment.vessel}</h2><span class="reference">{props.shipment.reference}</span><div class="shipment-card-route">{portName(props.shipment.origin)}<ArrowRight size={12} />{portName(props.shipment.destination)}</div><div class="shipment-card-footer"><span>ETA <strong>{date(props.shipment.eta)}</strong></span><Show when={props.shipment.delayHours > 0} fallback={<span class="containers">{props.shipment.containers} containers</span>}><span class="delay">+{props.shipment.delayHours}h</span></Show></div></button>;
}

function WorkspaceOperations(props: Readonly<{ workspaceId: string }>) {
  const [simulating, setSimulating] = createSignal(false);
  const feed = createWorkspaceFeed(props.workspaceId, simulating);
  const dashboard = feed.dashboard;
  const [selectedId, setSelectedId] = createSignal<string | null>(null);
  const [query, setQuery] = createSignal('');
  const [filter, setFilter] = createSignal<'all' | 'attention'>('all');
  const [error, setError] = createSignal<string | null>(null);
  const selected = createMemo(() => dashboard()?.shipments.find(shipment => shipment.id === selectedId()) ?? dashboard()?.shipments[0]);
  const shipments = createMemo(() => dashboard()?.shipments.filter(shipment => (filter() === 'all' || shipment.risk !== 'on-track') && `${shipment.vessel} ${shipment.reference} ${shipment.cargo}`.toLowerCase().includes(query().toLowerCase())) ?? []);
  const attention = () => dashboard()?.shipments.filter(item => item.risk !== 'on-track').length ?? 0;
  const failure = () => error() ?? feed.error();
  async function simulate() {
    setSimulating(true); setError(null);
    const result = await request(`/api/workspaces/${props.workspaceId}/disruptions`, dashboardSchema, { portId: 'singapore', delayHours: 36 }); setSimulating(false);
    if (result.ok) feed.accept(result.value); else setError(result.error);
  }
  return <>
    <Show when={failure()}>{message => <div class="global-error"><ErrorNote message={message()} /></div>}</Show>
    <main class="operations-layout"><aside class="shipments-panel"><div class="shipments-heading"><span class="section-kicker">YOUR OPERATIONS</span><h1>Shipments<span>{dashboard()?.shipments.length ?? '—'}</span></h1><p>Track ocean shipments and exceptions.</p></div><div class="shipment-search"><Search size={15} /><label class="sr-only" for="search">Search shipments</label><input id="search" value={query()} onInput={event => setQuery(event.currentTarget.value)} placeholder="Vessel, reference or cargo" /></div>
      <Tabs.Root value={filter()} onValueChange={details => setFilter(details.value === 'attention' ? 'attention' : 'all')}><Tabs.List class="filter-tabs"><Tabs.Trigger value="all">All shipments</Tabs.Trigger><Tabs.Trigger value="attention">Needs attention<span>{attention()}</span></Tabs.Trigger></Tabs.List></Tabs.Root>
      <div class="shipment-list"><Show when={!dashboard()}><div class="empty-state"><Radio size={22} /><p>{failure() ? 'Shipment updates unavailable.' : 'Loading your shipments…'}</p></div></Show><Show when={dashboard() && shipments().length === 0}><div class="empty-state"><Check size={22} /><p>{query() ? 'No shipments match your search.' : 'Nothing needs attention.'}</p></div></Show><For each={shipments()}>{shipment => <ShipmentCard shipment={shipment} ports={dashboard()?.ports ?? []} selected={selected()?.id === shipment.id} onSelect={setSelectedId} />}</For></div>
      <footer class="list-footer"><span class={`status-dot ${feed.mode()}`} /><span>{dashboard() ? `Updated ${time(dashboard()?.updatedAt ?? '')} UTC` : 'Connecting to workspace'}</span><span class={`feed-mode ${feed.mode()}`}>{feedLabel[feed.mode()]}</span></footer></aside>
      <section class="map-panel" aria-label="Shipment overview map"><div class="map-heading"><span><span class="status-dot" />OCEAN FREIGHT</span><span><Anchor size={13} />{dashboard()?.ports.length ?? '—'} ports in view</span></div><ShipmentMap dashboard={dashboard()} selected={selected()} focusId={selectedId()} onSelect={setSelectedId} /><div class="simulation-card"><span class="simulation-icon"><FlaskConical size={20} /></span><div><strong>Put the plan to the test.</strong><p>Simulate a 36-hour disruption at Singapore.<br />Watch affected arrivals and risks update.</p><button class="simulation-button" onClick={() => { void simulate(); }} disabled={simulating() || !dashboard()}><FlaskConical size={14} />{simulating() ? 'Assessing impact…' : 'Simulate port disruption'}<ArrowRight size={14} /></button></div></div><div class="runtime-note">{dashboard() ? `${dashboard()?.runtime} · ${dashboard()?.relay}` : 'Connecting…'}</div></section>
      <Show when={dashboard()}>{current => <Show when={selected()?.id} keyed>{id => <ShipmentDetails shipmentId={id} dashboard={current()} workspaceId={props.workspaceId} live={feed.mode() === 'live'} incoming={feed.comments()} />}</Show>}</Show>
    </main>
  </>;
}

function WorkspaceScreen(props: Readonly<{ session: Session; onSession: (session: Session) => void; onLogout: () => void }>) {
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
  return <div class="workspace-shell"><header class="topbar"><Brand /><div class="workspace-picker"><Layers3 size={15} /><label class="sr-only" for="workspace">Workspace</label><select id="workspace" value={workspaceId()} onChange={event => { setWorkspaceId(event.currentTarget.value); setTeamOpen(false); }}><For each={props.session.workspaces}>{item => <option value={item.id}>{item.name}</option>}</For></select><ChevronDown size={13} /></div><div class="topbar-right"><span class="demo-tag"><FlaskConical size={12} /> DEMO WORKSPACE</span><button class="team-button" onClick={() => setTeamOpen(true)} disabled={!workspace()}><Users size={15} />Team</button><span class="avatar" title={props.session.user.email}>{props.session.user.name.slice(0, 1).toUpperCase()}</span><button class="icon-button" onClick={props.onLogout} aria-label="Sign out"><LogOut size={16} /></button></div></header>
    <div class="simulation-banner"><span><span class="simulation-light" />Synthetic data<span class="banner-separator">/</span>Not live vessel tracking. Test a disruption to see its impact.</span><span class="banner-scope">ALL TIMES UTC</span></div>
    <Show when={inviteToken()}><div class="invite-banner"><span><Users size={16} />You have a workspace invitation. Signed in as {props.session.user.email}.</span><div class="invite-actions"><button disabled={accepting()} onClick={() => { void acceptInvitation(); }}>{accepting() ? 'Joining…' : 'Accept invitation'}<ArrowRight size={14} /></button><button disabled={accepting()} onClick={clearInvitation}>Use my workspace instead</button></div></div></Show>
    <Show when={error()}>{message => <div class="global-error"><ErrorNote message={message()} /></div>}</Show>
    <Show when={!inviteToken() ? workspace()?.id : undefined} keyed>{id => <WorkspaceOperations workspaceId={id} />}</Show>
    <Show when={workspace()} keyed>{item => <TeamPanel workspace={item} open={teamOpen()} onClose={() => setTeamOpen(false)} />}</Show></div>;
}

function App() {
  const [session, setSession] = createSignal<Session | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [initialError, setInitialError] = createSignal<string | null>(null);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  void request('/api/session', sessionSchema, undefined, controller.signal).then(result => { if (!controller.signal.aborted) { if (result.ok) setSession(result.value); else if (result.status !== 401) setInitialError(result.error); setLoading(false); } });
  async function logout() { const result = await request('/api/logout', z.unknown(), {}); if (result.ok) setSession(null); else window.alert(result.error); }
  return <Show when={!loading()} fallback={<div class="loading-screen"><Brand /><span>Opening your workspace…</span></div>}>
    <Show when={session()} fallback={<><Show when={initialError()}>{message => <div class="initial-error"><ErrorNote message={message()} /></div>}</Show><Authentication onSession={setSession} /></>}>{current => <WorkspaceScreen session={current()} onSession={setSession} onLogout={() => { void logout(); }} />}</Show>
  </Show>;
}

const root = document.getElementById('root');
if (root) render(() => <App />, root);
