import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Anchor, ArrowDownRight, ArrowRight, Check, ChevronDown, Compass, FlaskConical, Layers3, LogOut, MapPin, MessageSquare, Plus, Radio, Search, Send, Ship, TriangleAlert, Users, X } from 'lucide-react';
import { z } from 'zod';
import type { Comment, Dashboard, Shipment, Workspace } from '../shared';
import { commentsSchema, dashboardSchema, invitationSchema, membersSchema, request, sessionSchema, workspaceSchema, type Invitation, type Member, type Session } from './api';
import { MapBackdrop, ShipmentMap } from './Map';
import { mergeComment, type CommentEvent } from './feed';
import { useChangeFlash, useWorkspaceFeed, type FeedMode } from './live';
import './styles.css';

const date = (value: string): string => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const time = (value: string): string => new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
const feedLabel: Readonly<Record<FeedMode, string>> = { connecting: 'CONNECTING', live: 'LIVE', polling: 'REFRESHING EVERY 5 S' };
const riskLabel = { 'on-track': 'On schedule', watch: 'Watch', delayed: 'Delayed' };
const textField = (data: FormData, key: string): string => { const value = data.get(key); return typeof value === 'string' ? value : ''; };
const errorMessage = (error: string) => <p className="error-note" role="alert"><TriangleAlert size={15} />{error}</p>;

function Brand() { return <a className="brand" href="/" aria-label="Gazetteer home"><span className="brand-mark"><Compass size={25} strokeWidth={1.5} /></span>Gazetteer<span className="brand-dot">.</span></a>; }
function RiskBadge({ risk }: Readonly<{ risk: Shipment['risk'] }>) { return <span className={`risk-badge ${risk}`}>{risk === 'on-track' ? <span className="status-dot" /> : <TriangleAlert size={11} />}{riskLabel[risk]}</span>; }

function Authentication({ onSession }: Readonly<{ onSession: (session: Session) => void }>) {
  const [mode, setMode] = useState<'signup' | 'login'>('signup');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invited = new URLSearchParams(window.location.search).has('invite');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError(null);
    const result = await request(`/api/${mode}`, sessionSchema, { email: textField(data, 'email'), password: textField(data, 'password'), ...(mode === 'signup' ? { name: textField(data, 'name'), workspaceName: textField(data, 'workspaceName') || undefined } : {}) });
    setBusy(false);
    if (result.ok) onSession(result.value); else setError(result.error);
  }
  return <main className="auth-shell"><section className="auth-story"><Brand /><div className="auth-map"><MapBackdrop /></div><div className="auth-copy"><span className="eyebrow"><Radio size={14} /> A SHARED VIEW OF WHAT'S NEXT</span><h1>Cargo moves.<br />Stay ahead.</h1><p>Your shipments, their arrival times, and the changes that matter. All in one shared workspace.</p><div className="auth-features"><span><MapPin size={16} />Follow every shipment</span><span><TriangleAlert size={16} />See what needs attention</span><span><Users size={16} />Make the next call together</span></div></div><div className="auth-foot"><span>GAZETTEER / OPERATIONS</span><span>Clarity from origin to destination.</span></div></section>
    <section className="auth-panel"><div className="auth-form-wrap"><span className="demo-tag"><FlaskConical size={13} /> SYNTHETIC DEMO</span><h2>{invited ? 'Join your team.' : mode === 'signup' ? 'Your next clear view.' : 'Welcome back.'}</h2><p>{invited ? 'Sign in with your invited email, then accept your workspace invitation.' : mode === 'signup' ? 'Create an account to explore your shared shipment workspace.' : 'Sign in to pick up where your team left off.'}</p><div className="auth-tabs"><button className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(null); }}>Create account</button><button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(null); }}>Sign in</button></div>
      <form onSubmit={submit}>{mode === 'signup' && <label>Your name<input name="name" autoComplete="name" maxLength={80} required placeholder="Alex Morgan" /></label>}<label>Email<input name="email" type="email" autoComplete="email" required placeholder="you@company.com" /></label><label>Password<input name="password" type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} minLength={12} required placeholder="At least 12 characters" /></label>{mode === 'signup' && <label>Workspace name <span className="optional">optional</span><input name="workspaceName" maxLength={100} placeholder="Your logistics team" /></label>}{error && errorMessage(error)}<button className="primary full" disabled={busy}>{busy ? 'Connecting…' : mode === 'signup' ? 'Create workspace' : 'Sign in'}<ArrowRight size={16} /></button></form>
      <p className="auth-disclaimer">Demo shipments and disruptions are simulated. No live vessel positions or carrier feeds are connected.</p></div></section></main>;
}

const invitationCopy = (invitation: Invitation): Readonly<{ title: string; detail: string }> => {
  switch (invitation.delivery) {
    case 'accepted': return { title: 'Invitation email submitted', detail: `The email provider accepted the invitation for ${invitation.email}. Inbox delivery is not confirmed.` };
    case 'unconfirmed': return { title: 'Email delivery unconfirmed', detail: `${invitation.warning} Share this link with ${invitation.email}; they must sign in with that address.` };
    case 'link-only': return { title: 'Invitation ready — email not sent', detail: `Share this link with ${invitation.email}. They must sign in with that email to join.` };
  }
};

function TeamPanel({ workspace, onClose }: Readonly<{ workspace: Workspace; onClose: () => void }>) {
  const [members, setMembers] = useState<readonly Member[]>([]);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void request(`/api/workspaces/${workspace.id}/members`, membersSchema, undefined, controller.signal).then(result => { if (!controller.signal.aborted) { if (result.ok) setMembers(result.value.members); else setError(result.error); } });
    return () => controller.abort();
  }, [workspace.id]);
  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const email = textField(new FormData(event.currentTarget), 'email'); setBusy(true); setError(null); setInvitation(null);
    const result = await request(`/api/workspaces/${workspace.id}/invitations`, invitationSchema, { email }); setBusy(false);
    if (result.ok) setInvitation(result.value); else setError(result.error);
  }
  return <div className="modal-backdrop"><section className="team-dialog" role="dialog" aria-modal="true" aria-labelledby="team-title"><button className="icon-button dialog-close" onClick={onClose} aria-label="Close team settings"><X size={20} /></button><span className="section-kicker">SHARED WORKSPACE</span><h2 id="team-title">Your team, in sync.</h2><p>Members share shipments, updates and comments in <strong>{workspace.name}</strong>.</p><div className="member-list">{members.map(member => <div className="member" key={member.id}><span className="avatar">{member.name.slice(0, 1).toUpperCase()}</span><div><strong>{member.name}</strong><small>{member.email}</small></div><span className="member-role">{member.role}</span></div>)}</div>{workspace.role === 'owner' ? <form onSubmit={invite}><label>Invite by email<input type="email" name="email" placeholder="teammate@company.com" required /></label><button className="primary full" disabled={busy}><Plus size={16} />{busy ? 'Creating invitation…' : 'Invite teammate'}</button></form> : <p className="muted">Only the workspace owner can invite teammates.</p>}{error && errorMessage(error)}{invitation && <div className="invitation-result"><strong>{invitationCopy(invitation).title}</strong><p>{invitationCopy(invitation).detail}</p><label>Invitation link<input readOnly value={invitation.url} onFocus={event => event.currentTarget.select()} /></label></div>}</section></div>;
}

function ShipmentDetails({ shipment, dashboard, workspaceId, live, incoming }: Readonly<{ shipment: Shipment; dashboard: Dashboard; workspaceId: string; live: boolean; incoming: readonly CommentEvent[] }>) {
  const [comments, setComments] = useState<readonly Comment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const path = `/api/workspaces/${workspaceId}/shipments/${shipment.id}/comments`;
  useEffect(() => {
    if (sending) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const load = (): Promise<void> => controller.signal.aborted ? Promise.resolve() : request(path, commentsSchema, undefined, controller.signal).then(result => { if (!controller.signal.aborted) { if (result.ok) { setComments(result.value.comments); setLoadError(null); } else setLoadError(result.error); if (!live) timer = window.setTimeout(() => { void load(); }, 5000); } });
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [path, sending, live]);
  useEffect(() => {
    const fresh = incoming.filter(event => event.shipmentId === shipment.id);
    if (fresh.length > 0) setComments(current => fresh.reduce((merged, event) => mergeComment(merged, event.comment), current));
  }, [incoming, shipment.id]);
  const etaFlash = useChangeFlash(shipment.eta);
  const changeFlash = useChangeFlash(shipment.change);
  async function comment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const body = textField(new FormData(form), 'body'); setSending(true); setError(null);
    const result = await request(path, commentsSchema, { body }); setSending(false);
    if (result.ok) { setComments(result.value.comments); form.reset(); } else setError(result.error);
  }
  const portName = (id: string): string => dashboard.ports.find(port => port.id === id)?.name ?? id;
  return <aside className="detail-panel" aria-label={`Details for ${shipment.vessel}`}>
    <div className="detail-title"><div><span className="section-kicker">SHIPMENT DETAILS</span><h2>{shipment.vessel}</h2><span className="reference">{shipment.reference}</span></div><span className="detail-ship"><Ship size={24} strokeWidth={1.4} /></span></div>
    <div className="detail-route"><span>{portName(shipment.origin)}</span><ArrowRight size={15} /><span>{portName(shipment.destination)}</span></div><div className="cargo-line">{shipment.cargo}<span>·</span>{shipment.containers} containers</div>
    <section className={`eta-card${etaFlash ? ' flash' : ''}`}><div className="eta-heading"><span>CURRENT ETA</span><RiskBadge risk={shipment.risk} /></div><div className="eta-date">{date(shipment.eta)}<small>{time(shipment.eta)} UTC</small></div><div className={`eta-delta ${shipment.delayHours > 0 ? 'changed' : ''}`}>{shipment.delayHours > 0 ? <><ArrowDownRight size={15} />+{shipment.delayHours}h from original schedule<span>Was {date(shipment.baselineEta)}</span></> : <><Check size={14} />No change to arrival schedule</>}</div></section>
    <section className={`detail-section what-changed${changeFlash || etaFlash ? ' flash' : ''}`}><h3>What changed{(changeFlash || etaFlash) && <span className="live-chip">UPDATED</span>}</h3><p>{shipment.change}</p>{shipment.action && <div className="action-box"><TriangleAlert size={16} /><div><strong>Action needed</strong><p>{shipment.action}</p></div></div>}</section>
    <section className="detail-section"><h3>Route milestones</h3><ol className="milestones">{shipment.milestones.map((milestone, index) => <li className={milestone.status} key={`${milestone.label}-${index}`}><span className="milestone-node">{milestone.status === 'complete' && <Check size={10} />}</span><div><strong>{milestone.label}</strong><small>{date(milestone.at)} · {time(milestone.at)} UTC</small></div>{milestone.status === 'current' && <span className="current-label">CURRENT</span>}</li>)}</ol></section>
    <section className="detail-section"><h3>Supporting evidence<span className="mini-sim">SIMULATED</span></h3>{shipment.evidence.length === 0 ? <p className="muted">No disruption reported in this demo.</p> : shipment.evidence.map(evidence => <article className="evidence" key={evidence.id}><div><FlaskConical size={14} /><strong>{evidence.title}</strong></div><p>{evidence.detail}</p><small>Scenario source · {date(evidence.observedAt)}, {time(evidence.observedAt)} UTC</small></article>)}</section>
    <section className="detail-section comments"><h3><MessageSquare size={15} />Team notes<span className="note-count">{comments.length}</span></h3>{comments.length === 0 && <p className="muted">Keep the next handoff in view. Add a note for your team.</p>}{comments.map(comment => <article className="comment" key={comment.id}><div><strong>{comment.author}</strong><small>{date(comment.createdAt)}, {time(comment.createdAt)}</small></div><p>{comment.body}</p></article>)}<form onSubmit={comment}><label className="sr-only" htmlFor="comment-body">Add a team note</label><textarea id="comment-body" name="body" placeholder="Add a note for your team…" maxLength={4000} required rows={2} /><button className="text-button" disabled={sending}>{sending ? 'Posting…' : 'Post note'}<Send size={13} /></button></form>{(error ?? loadError) && errorMessage(error ?? loadError ?? '')}</section>
  </aside>;
}

function ShipmentCard({ shipment, ports, selected, onSelect }: Readonly<{ shipment: Shipment; ports: Dashboard['ports']; selected: boolean; onSelect: (id: string) => void }>) {
  const flash = useChangeFlash(shipment.eta);
  const portName = (id: string): string | undefined => ports.find(port => port.id === id)?.name;
  return <button className={`shipment-card ${selected ? 'selected' : ''}${flash ? ' flash' : ''}`} onClick={() => onSelect(shipment.id)} aria-pressed={selected}><div className="shipment-card-top"><span className="small-ship"><Ship size={17} /></span><RiskBadge risk={shipment.risk} /></div><h2>{shipment.vessel}</h2><span className="reference">{shipment.reference}</span><div className="shipment-card-route">{portName(shipment.origin)}<ArrowRight size={12} />{portName(shipment.destination)}</div><div className="shipment-card-footer"><span>ETA <strong>{date(shipment.eta)}</strong></span>{shipment.delayHours > 0 ? <span className="delay">+{shipment.delayHours}h</span> : <span className="containers">{shipment.containers} containers</span>}</div></button>;
}

function WorkspaceOperations({ workspaceId }: Readonly<{ workspaceId: string }>) {
  const [simulating, setSimulating] = useState(false);
  const feed = useWorkspaceFeed(workspaceId, simulating);
  const { dashboard, mode } = feed;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'attention'>('all');
  const [error, setError] = useState<string | null>(null);
  const loadError = feed.error;
  const selected = dashboard?.shipments.find(shipment => shipment.id === selectedId) ?? dashboard?.shipments[0];
  const shipments = dashboard?.shipments.filter(shipment => (filter === 'all' || shipment.risk !== 'on-track') && `${shipment.vessel} ${shipment.reference} ${shipment.cargo}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  async function simulate() {
    setSimulating(true); setError(null);
    const result = await request(`/api/workspaces/${workspaceId}/disruptions`, dashboardSchema, { portId: 'singapore', delayHours: 36 }); setSimulating(false);
    if (result.ok) feed.accept(result.value); else setError(result.error);
  }
  return <>{(error ?? loadError) && <div className="global-error">{errorMessage(error ?? loadError ?? '')}</div>}
    <main className="operations-layout"><aside className="shipments-panel"><div className="shipments-heading"><span className="section-kicker">YOUR OPERATIONS</span><h1>Shipments<span>{dashboard?.shipments.length ?? '—'}</span></h1><p>Track ocean shipments and exceptions.</p></div><div className="shipment-search"><Search size={15} /><label className="sr-only" htmlFor="search">Search shipments</label><input id="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Vessel, reference or cargo" /></div><div className="filter-tabs"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All shipments</button><button className={filter === 'attention' ? 'active' : ''} onClick={() => setFilter('attention')}>Needs attention<span>{dashboard?.shipments.filter(item => item.risk !== 'on-track').length ?? 0}</span></button></div><div className="shipment-list">{!dashboard && <div className="empty-state"><Radio size={22} /><p>{(error ?? loadError) ? 'Shipment updates unavailable.' : 'Loading your shipments…'}</p></div>}{dashboard && shipments.length === 0 && <div className="empty-state"><Check size={22} /><p>{query ? 'No shipments match your search.' : 'Nothing needs attention.'}</p></div>}{shipments.map(shipment => <ShipmentCard key={shipment.id} shipment={shipment} ports={dashboard?.ports ?? []} selected={selected?.id === shipment.id} onSelect={setSelectedId} />)}</div><footer className="list-footer"><span className={`status-dot ${mode}`} /><span>{dashboard ? `Updated ${time(dashboard.updatedAt)} UTC` : 'Connecting to workspace'}</span><span className={`feed-mode ${mode}`}>{feedLabel[mode]}</span></footer></aside>
      <section className="map-panel" aria-label="Shipment overview map"><div className="map-heading"><span><span className="status-dot" />OCEAN FREIGHT</span><span><Anchor size={13} />{dashboard?.ports.length ?? '—'} ports in view</span></div><ShipmentMap dashboard={dashboard} selected={selected} focusId={selectedId} onSelect={setSelectedId} /><div className="simulation-card"><span className="simulation-icon"><FlaskConical size={20} /></span><div><strong>Put the plan to the test.</strong><p>Simulate a 36-hour disruption at Singapore.<br />Watch affected arrivals and risks update.</p><button className="simulation-button" onClick={() => { void simulate(); }} disabled={simulating || !dashboard}><FlaskConical size={14} />{simulating ? 'Assessing impact…' : 'Simulate port disruption'}<ArrowRight size={14} /></button></div></div><div className="runtime-note">{dashboard ? `${dashboard.runtime} · ${dashboard.relay}` : 'Connecting…'}</div></section>
      {selected && dashboard && <ShipmentDetails key={`${workspaceId}/${selected.id}`} shipment={selected} dashboard={dashboard} workspaceId={workspaceId} live={mode === 'live'} incoming={feed.comments} />}
    </main>
  </>;
}

function WorkspaceScreen({ session, onSession, onLogout }: Readonly<{ session: Session; onSession: (session: Session) => void; onLogout: () => void }>) {
  const [workspaceId, setWorkspaceId] = useState(session.workspaces[0]?.id ?? '');
  const [teamOpen, setTeamOpen] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteToken, setInviteToken] = useState(new URLSearchParams(window.location.search).get('invite'));
  const workspace = session.workspaces.find(item => item.id === workspaceId);
  function clearInvitation() {
    setInviteToken(null); setError(null);
    window.history.replaceState(null, '', window.location.pathname);
  }
  async function acceptInvitation() {
    setAccepting(true); setError(null);
    const result = await request('/api/invitations/accept', workspaceSchema, { token: inviteToken });
    setAccepting(false);
    if (result.ok) { onSession({ ...session, workspaces: [...session.workspaces.filter(item => item.id !== result.value.id), result.value] }); setWorkspaceId(result.value.id); setTeamOpen(false); clearInvitation(); } else setError(result.error);
  }
  return <div className="workspace-shell"><header className="topbar"><Brand /><div className="workspace-picker"><Layers3 size={15} /><label className="sr-only" htmlFor="workspace">Workspace</label><select id="workspace" value={workspaceId} onChange={event => { setWorkspaceId(event.target.value); setTeamOpen(false); }}>{session.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={13} /></div><div className="topbar-right"><span className="demo-tag"><FlaskConical size={12} /> DEMO WORKSPACE</span><button className="team-button" onClick={() => setTeamOpen(true)} disabled={!workspace}><Users size={15} />Team</button><span className="avatar" title={session.user.email}>{session.user.name.slice(0, 1).toUpperCase()}</span><button className="icon-button" onClick={onLogout} aria-label="Sign out"><LogOut size={16} /></button></div></header>
    <div className="simulation-banner"><span><span className="simulation-light" />Synthetic data<span className="banner-separator">/</span>Not live vessel tracking. Test a disruption to see its impact.</span><span className="banner-scope">ALL TIMES UTC</span></div>
    {inviteToken && <div className="invite-banner"><span><Users size={16} />You have a workspace invitation. Signed in as {session.user.email}.</span><div className="invite-actions"><button disabled={accepting} onClick={() => { void acceptInvitation(); }}>{accepting ? 'Joining…' : 'Accept invitation'}<ArrowRight size={14} /></button><button disabled={accepting} onClick={clearInvitation}>Use my workspace instead</button></div></div>}
    {error && <div className="global-error">{errorMessage(error)}</div>}
    {workspace && !inviteToken && <WorkspaceOperations key={workspace.id} workspaceId={workspace.id} />}
    {teamOpen && workspace && <TeamPanel key={`team/${workspace.id}`} workspace={workspace} onClose={() => setTeamOpen(false)} />}</div>;
}

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialError, setInitialError] = useState<string | null>(null);
  useEffect(() => { const controller = new AbortController(); void request('/api/session', sessionSchema, undefined, controller.signal).then(result => { if (!controller.signal.aborted) { if (result.ok) setSession(result.value); else if (result.status !== 401) setInitialError(result.error); setLoading(false); } }); return () => controller.abort(); }, []);
  async function logout() { const result = await request('/api/logout', z.unknown(), {}); if (result.ok) setSession(null); else window.alert(result.error); }
  if (loading) return <div className="loading-screen"><Brand /><span>Opening your workspace…</span></div>;
  return session ? <WorkspaceScreen session={session} onSession={setSession} onLogout={() => { void logout(); }} /> : <>{initialError && <div className="initial-error">{errorMessage(initialError)}</div>}<Authentication onSession={setSession} /></>;
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
