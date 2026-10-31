import type { BoardKind, BoardMessage } from '../core/board';
import type { Port } from '../core/types';
import { concerns } from '../core/board';

export const boardKinds: Readonly<Record<BoardKind, string>> = {
  'port.bulletin': 'Port bulletin', 'ship.observation': 'Vessel observation',
  'ship.assessment': 'Risk assessment', 'ship.eta': 'Arrival update',
};
export const boardTime = (value: string): string => new Date(value).toLocaleString('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
}) + ' UTC';
export const boardPort = (id: string, ports: readonly Port[]): string =>
  ports.find(port => port.id === id)?.name ?? id.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
export const boardAuthor = (message: BoardMessage, ports: readonly Port[]): string =>
  message.author.role === 'ship' ? message.author.vessel : boardPort(message.author.id, ports);
export const boardRisk = { 'on-track': 'Low risk', watch: 'Moderate risk', delayed: 'High risk', normal: 'Normal conditions', elevated: 'Elevated port risk', severe: 'Severe port risk' };
const signals = { 'off-route': 'Away from the planned route', 'slow-steaming': 'Moving slowly', 'stationary-outside-port': 'Stationary outside port', 'ais-dark': 'Position reports missing' };

export function boardExplanation(message: BoardMessage, ports: readonly Port[]): string {
  switch (message.kind) {
    case 'ship.eta': {
      const hours = (Date.parse(message.eta) - Date.parse(message.previousEta)) / 3_600_000;
      const delta = Math.abs(hours).toLocaleString('en-US', { maximumFractionDigits: 1 });
      return `Arrival at ${boardPort(message.portId, ports)} is expected ${boardTime(message.eta)}.${hours ? ` ${delta} hours ${hours > 0 ? 'later' : 'earlier'} than the previous estimate.` : ' The arrival estimate is unchanged.'}`;
    }
    case 'ship.observation': return `${message.signals.map(signal => signals[signal]).join('; ')}${message.nearPort ? ` near ${boardPort(message.nearPort, ports)}` : ''}. Observed ${boardTime(message.observedAt)} via ${message.provider}.`;
    case 'port.bulletin': return `${boardRisk[message.risk]}. ${message.anchored} vessel${message.anchored === 1 ? '' : 's'} at anchor; ${message.arrivals48h} expected arrival${message.arrivals48h === 1 ? '' : 's'} over the next 48 hours.`;
    case 'ship.assessment': return `${boardRisk[message.risk]}. Arrival expected ${boardTime(message.eta)}.${message.delayHours ? ` Estimated delay: ${message.delayHours.likely} hours${message.delayHours.low === message.delayHours.high ? "" : ` (${message.delayHours.low}–${message.delayHours.high} hours)`}.` : ''}`;
  }
}

/** Preserve the agent's reasoning, but translate transport labels and ISO timestamps for readers. */
export function readableBoardSummary(message: BoardMessage, ports: readonly Port[]): string {
  let original = message.summary;
  if (message.kind === 'ship.assessment') {
    original = original.replace(/^.*?: (?:on-track|watch|delayed), ETA .*?\(.*?h\)\.\s*/, '');
    original = original.replace(/Deterministic fallback \([^)]*\):\s*/g, 'Rule-based estimate: ');
  }
  let summary = original.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z/g, value => boardTime(value));
  for (const port of ports) summary = summary.replaceAll(port.id, port.name);
  return summary.replace(/\bon-track\b/g, 'low risk').replace(/\bais-dark\b/g, 'position reports missing').replace(/\bslow-steaming\b/g, 'moving slowly').replace(/\bstationary-outside-port\b/g, 'stationary outside port').replace(/\boff-route\b/g, 'away from the planned route');
}

export function filterBoard(messages: readonly BoardMessage[], kind: string, entity: string, query: string, ports: readonly Port[]): readonly BoardMessage[] {
  const needle = query.trim().toLocaleLowerCase();
  return messages.filter(message => {
    const relevant = concerns(message);
    const matchesEntity = entity === 'all' || entity === `ship:${relevant.shipmentId}` || relevant.ports.some(id => entity === `port:${id}`);
    const searchable = `${boardAuthor(message, ports)} ${readableBoardSummary(message, ports)} ${boardExplanation(message, ports)} ${boardKinds[message.kind]}`.toLocaleLowerCase();
    return (kind === 'all' || message.kind === kind) && matchesEntity && (!needle || searchable.includes(needle));
  }).toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id));
}
