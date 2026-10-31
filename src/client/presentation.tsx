import { Show } from 'solid-js';
import { FlaskConical, Radio, TriangleAlert } from 'lucide-solid';
import type { PortId } from '../core/ports';
import type { Dashboard, Evidence, Shipment } from '../core/types';

export const date = (value: string): string => new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
export const time = (value: string): string => new Date(value).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
export const portName = (ports: Dashboard['ports'], id: PortId): string => ports.find(port => port.id === id)?.name ?? id;
const riskLabel: Readonly<Record<Shipment['risk'], string>> = { 'on-track': 'On schedule', watch: 'Watch', delayed: 'Delayed' };

export function RiskBadge(props: Readonly<{ risk: Shipment['risk'] }>) {
  return <span class={`risk-badge ${props.risk}`}><Show when={props.risk !== 'on-track'} fallback={<span class="status-dot" />}><TriangleAlert size={11} /></Show>{riskLabel[props.risk]}</span>;
}

const externalSourceUrl = (value: string): string | undefined => {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password ? url.href : undefined;
};

export function EvidenceCard(props: Readonly<{ evidence: Evidence }>) {
  const attribution = () => {
    const evidence = props.evidence;
    switch (evidence.source) {
      case 'live': return <>Live source · <Show when={externalSourceUrl(evidence.url)} fallback={<>{evidence.provider} · source link unavailable</>}>{url => <a href={url()} target="_blank" rel="noopener noreferrer">{evidence.provider}</a>}</Show></>;
      case 'simulation': return <>Simulated source</>;
    }
    const unhandled: never = evidence;
    return unhandled;
  };
  return <article class="evidence"><div><Show when={props.evidence.source === 'live'} fallback={<FlaskConical size={14} />}><Radio size={14} /></Show><strong>{props.evidence.title}</strong></div><p>{props.evidence.detail}</p><small>{attribution()} · <time dateTime={props.evidence.observedAt}>{date(props.evidence.observedAt)}, {time(props.evidence.observedAt)} UTC</time></small></article>;
}
