import { useState } from 'react';
import { ArrowRight, ExternalLink, Newspaper, Route, TriangleAlert } from 'lucide-react';
import type { Dashboard, Diversion, Evidence, NewsRelevance, Shipment } from '../shared';

const labels = { route: 'Planned route', diversion: 'Diversion', context: 'Regional context' } as const;
const observed = (value: string) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

export function EvidenceCard({ evidence, reasons }: Readonly<{ evidence: Evidence; reasons: readonly NewsRelevance[] }>) {
  return <article className="news-card"><div className="news-tags">{[...new Set(reasons.map(reason => reason.kind))].map(kind => <span key={kind} className={`news-tag ${kind}`}>{labels[kind]}</span>)}<span className="news-source">{evidence.source === 'live' ? evidence.provider.toUpperCase() : 'SIMULATED'}</span></div><h3>{evidence.title}</h3><p>{evidence.detail}</p><div className="news-reasons">{[...new Set(reasons.map(reason => reason.reason))].map(reason => <p key={reason}><Route size={12} />{reason}</p>)}</div><footer><time dateTime={evidence.observedAt}>{observed(evidence.observedAt)} UTC</time>{evidence.source === 'live' && <a href={evidence.url} target="_blank" rel="noreferrer">Source<ExternalLink size={11} /></a>}</footer></article>;
}

export function IntelligencePanel({ dashboard, shipment, inspected, onInspect }: Readonly<{ dashboard: Dashboard; shipment?: Shipment; inspected: string | null; onInspect: (option: Diversion | null) => void }>) {
  const [scope, setScope] = useState<'all' | NewsRelevance['kind']>('all');
  const intelligence = dashboard.intelligence;
  const items = (intelligence?.items ?? []).map(item => ({ ...item, relevance: item.relevance.filter(reason => !shipment || reason.shipmentId === shipment.id) })).filter(item => item.relevance.length);
  const filtered = items.filter(item => scope === 'all' || item.relevance.some(reason => reason.kind === scope));
  const alternatives = (intelligence?.diversions ?? []).filter(option => !shipment || option.shipmentId === shipment.id);
  return <section className="intelligence-panel" aria-label={shipment ? `News and alternatives for ${shipment.vessel}` : 'Fleet intelligence'}><div className="intelligence-title"><span className="section-kicker">{shipment ? 'VOYAGE INTELLIGENCE' : 'BEYOND THE ROUTE'}</span><h2><Newspaper size={20} />{shipment ? 'The broader picture' : 'Signals to watch'}<span>{items.length}</span></h2><p>{shipment ? 'Evidence for this voyage, its alternatives, and the waters ahead.' : 'News affecting your shipments and the alternatives worth keeping in view.'}</p></div>
    <div className="news-filters" aria-label="News relevance">{(['all', 'route', 'diversion', 'context'] as const).map(kind => <button key={kind} aria-pressed={scope === kind} className={scope === kind ? 'active' : ''} onClick={() => setScope(kind)}>{kind === 'all' ? 'All signals' : labels[kind]}</button>)}</div>
    {intelligence && <p className="feed-health">{intelligence.sourcesEnabled ? `Feeds checked ${observed(intelligence.checkedAt)} UTC` : 'Live news feeds are off. Showing retained scenario evidence.'}</p>}
    {Boolean(intelligence?.unavailableProviders.length) && <p className="news-warning" role="status"><TriangleAlert size={14} />{intelligence?.unavailableProviders.join(', ').toUpperCase()} unavailable. Coverage is incomplete.</p>}
    {!intelligence && <p className="news-warning">Broader news coverage is unavailable in this snapshot.</p>}
    <div className="news-list">{filtered.map(item => <EvidenceCard key={item.evidence.id} evidence={item.evidence} reasons={item.relevance.filter(reason => scope === 'all' || reason.kind === scope)} />)}{filtered.length === 0 && <div className="news-empty"><Newspaper size={25} /><h3>No matching signals</h3><p>No {scope === 'all' ? 'relevant' : labels[scope].toLowerCase()} news in the available feed. This is not an all-clear.</p></div>}</div>
    <section className="diversion-section"><div className="section-kicker">KEEP YOUR OPTIONS OPEN</div><h3>Potential diversions</h3><p className="diversion-note">Planning candidates. Carrier acceptance, capacity and revised ETA are unconfirmed.</p>{alternatives.map(option => {
      const affected = items.filter(item => item.relevance.some(reason => reason.diversionId === option.id)).length;
      return <article key={option.id} className={`diversion-card ${inspected === option.id ? 'inspected' : ''}`}><div><h4>{option.name}</h4><span>Instead of {dashboard.ports.find(port => port.id === option.replaces)?.name}</span></div>{!shipment && <small>{dashboard.shipments.find(ship => ship.id === option.shipmentId)?.vessel}</small>}<p>{option.reason}</p><p className="diversion-constraint">{option.constraint}</p><footer><span>{affected ? `${affected} relevant signal${affected === 1 ? '' : 's'}` : 'No matching signals · unverified'}</span><button aria-pressed={inspected === option.id} onClick={() => onInspect(inspected === option.id ? null : option)}>{inspected === option.id ? 'Hide on map' : 'Inspect on map'}<ArrowRight size={13} /></button></footer></article>;
    })}{alternatives.length === 0 && <p className="muted">No upcoming port alternatives for this voyage.</p>}</section>
  </section>;
}
