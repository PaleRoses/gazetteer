import { routeThrough } from './sea-routes';
import type { MonitoredRoute, PortId, Shipment } from './shared';

export const corridorId = (from: PortId, to: PortId): string => [from, to].sort().join('~');
/** Membership follows consecutive calls, not just equal end destinations. Directions share a corridor. */
export function monitoredRoutes(shipments: readonly Shipment[]): readonly MonitoredRoute[] {
  const groups = new Map<string, { endpoints: [PortId, PortId]; members: Map<string, Shipment> }>();
  for (const shipment of shipments) {
    const calls = [shipment.origin, ...shipment.via, shipment.destination];
    for (let i = 1; i < calls.length; i++) {
      const from = calls[i - 1]!, to = calls[i]!;
      if (from === to) continue;
      const id = corridorId(from, to);
      const group = groups.get(id) ?? { endpoints: [from, to].sort() as [PortId, PortId], members: new Map<string, Shipment>() };
      group.members.set(shipment.id, shipment);
      groups.set(id, group);
    }
  }
  return [...groups].map(([id, group]): MonitoredRoute => {
    const members = [...group.members.values()];
    const attention = members.filter(s => s.risk !== 'on-track').length;
    const risk = members.some(s => s.risk === 'delayed') ? 'delayed' : attention ? 'watch' : 'on-track';
    return { id, endpoints: group.endpoints, path: routeThrough(group.endpoints) ?? [], shipmentIds: members.map(s => s.id).sort(), risk, attention,
      maxDelayHours: Math.max(0, ...members.map(s => s.delayHours)),
      summary: attention ? `${attention} of ${members.length} monitored shipments need attention; delays may originate on another leg.` : `No assessed delays among ${members.length} monitored shipment${members.length === 1 ? '' : 's'}. This is not a corridor-wide all-clear.`,
    };
  }).sort((a, b) => b.attention - a.attention || a.id.localeCompare(b.id));
}
