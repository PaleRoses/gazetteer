import { monitoredRoutes, corridorId } from '../routes';
import type { IntelligenceItem, MonitoredRoute, Shipment } from '../shared';
import { buildIntelligence } from './intelligence';
import type { Notice } from './sources/notice';

/** Read model of durable shipment state: never writes an ETA or invents a route-level AI assessment. */
export function buildRouteMonitoring(shipments: readonly Shipment[], notices: readonly Notice[], now: Date, failures: readonly string[] = [], enabled = true): readonly MonitoredRoute[] {
  return monitoredRoutes(shipments).map(route => {
    const members = shipments.filter(s => route.shipmentIds.includes(s.id));
    const legs = members.flatMap(shipment => {
      const calls = [shipment.origin, ...shipment.via, shipment.destination];
      return calls.slice(1).flatMap((to, index) => corridorId(calls[index]!, to) !== route.id ? [] : [{
        ...shipment, origin: calls[index]!, destination: to, via: [], route: route.path,
        evidence: [],
      }]);
    });
    const intelligence = buildIntelligence(legs, notices, now, failures, enabled, 'corridor');
    const items = new Map<string, IntelligenceItem>(intelligence.items.map(item => [item.evidence.id, item]));
    for (const member of members) for (const evidence of member.evidence) {
      const held = items.get(evidence.id);
      if (held) continue;
      items.set(evidence.id, { evidence, coordinates: null, relevance: members.filter(s => s.evidence.some(e => e.id === evidence.id)).map(s => ({
        shipmentId: s.id, kind: 'context', reason: `${s.vessel}: retained voyage evidence; its location within this corridor is unconfirmed.`,
      })) });
    }
    return { ...route, intelligence: { ...intelligence,
      items: [...items.values()].sort((a, b) => Date.parse(b.evidence.observedAt) - Date.parse(a.evidence.observedAt)).map(item => ({ ...item, relevance: item.relevance.map(r => ({ ...r, reason: r.reason.replace('remaining planned sea corridor', 'monitored sea corridor').replace('remaining voyage corridor', 'monitored corridor').replace('upcoming ', 'corridor endpoint ') })) })),
      diversions: [...new Map(intelligence.diversions.map(d => [d.id, d])).values()],
    } };
  });
}
