import { ports } from '../domain';
import { progressAt, splitAt, unwrap, voyageRoute } from '../sea-routes';
import type { Diversion, Intelligence, IntelligenceItem, NewsRelevance, PortId, Shipment } from '../shared';
import { anchors, distanceToGeometryKm, nearestOnPath } from './sources/geo';
import { isActive, radiusKm } from './sources/exposure';
import type { Notice } from './sources/notice';

const options: Readonly<Record<PortId, Omit<Diversion, 'id' | 'shipmentId' | 'replaces'>>> = {
  'jebel-ali': { name: 'Fujairah', coordinates: [56.36, 25.18], reason: 'A Gulf of Oman port outside the Strait of Hormuz for a carrier-approved change of discharge.', constraint: 'Confirm cargo handling, berth acceptance and overland transport; the alternate port is not a verified safe haven.' },
  singapore: { name: 'Port Klang', coordinates: [101.35, 3.0], reason: 'A nearby transshipment option if the Singapore call becomes constrained.', constraint: 'Confirm berth capacity, feeder connections and customs with the carrier.' },
  rotterdam: { name: 'Antwerp-Bruges', coordinates: [4.29, 51.3], reason: 'An alternative North European discharge port for onward delivery.', constraint: 'Confirm berth acceptance and the revised inland delivery plan.' },
  shanghai: { name: 'Ningbo-Zhoushan', coordinates: [121.85, 29.9], reason: 'A regional discharge option if the Shanghai arrival is disrupted.', constraint: 'Confirm cargo acceptance, customs and onward transport.' },
  'los-angeles': { name: 'Oakland', coordinates: [-122.32, 37.8], reason: 'An alternative US West Coast discharge port.', constraint: 'Confirm vessel service, berth availability and the additional inland journey.' },
};

export const remainingRoute = (shipment: Shipment, now: Date) => {
  const route = voyageRoute(shipment) ?? unwrap(shipment.route);
  const departure = shipment.milestones[0]?.at;
  return splitAt(route, departure ? progressAt(departure, shipment.eta, now.getTime()) : 0).ahead;
};

export const callsAhead = (shipment: Shipment, now: Date): readonly PortId[] => {
  if (Date.parse(shipment.eta) <= now.getTime()) return [];
  const ahead = remainingRoute(shipment, now);
  return [...shipment.via.filter(id => {
    const call = shipment.milestones.find(milestone => /transshipment/i.test(milestone.label));
    if (call) return call.status !== 'complete' && Date.parse(call.at) >= now.getTime();
    const port = ports.find(port => port.id === id);
    return port && ahead.length >= 2 && (nearestOnPath({ kind: 'point', coordinates: port.coordinates }, ahead)?.distanceKm ?? Infinity) < 50;
  }), shipment.destination];
};

/** Planning candidates only. Neither selecting one nor reading its news changes a voyage. */
export const diversionsFor = (shipment: Shipment, now: Date): readonly Diversion[] => callsAhead(shipment, now).map(replaces => ({
  ...options[replaces], id: `${shipment.id}:${replaces}`, shipmentId: shipment.id, replaces,
}));

const relevanceFor = (notice: Notice, shipment: Shipment, diversions: readonly Diversion[], now: Date, scope: 'voyage' | 'corridor'): readonly NewsRelevance[] => {
  if (scope === 'voyage' && Date.parse(shipment.eta) <= now.getTime()) return [];
  const calls = scope === 'corridor' ? [shipment.origin, shipment.destination] : callsAhead(shipment, now);
  const ahead = scope === 'corridor' ? voyageRoute(shipment) ?? unwrap(shipment.route) : remainingRoute(shipment, now);
  const reach = radiusKm[notice.kind];
  const call = ports.find(port => calls.includes(port.id) && (notice.geometry.kind === 'zone'
    ? notice.geometry.portIds.includes(port.id)
    : (distanceToGeometryKm(notice.geometry, port.coordinates) ?? Infinity) <= reach));
  const laneDistance = ahead.length >= 2 ? nearestOnPath(notice.geometry, ahead)?.distanceKm ?? Infinity : Infinity;
  // Editorial pins represent regions, not exact incident coordinates or threat boundaries.
  if (notice.report) {
    if (notice.report.kind === 'advisory' && laneDistance <= reach) return [{ shipmentId: shipment.id, kind: 'route', reason: `The planned sea corridor passes near ${notice.report.region}. Review the advisory; vessel-specific impact is unconfirmed.` }];
    return laneDistance <= 500 ? [{ shipmentId: shipment.id, kind: 'context', reason: `${notice.report.region} is near the voyage corridor. Regional security context; no confirmed impact on this ship.` }] : [];
  }
  const route: NewsRelevance[] = call || laneDistance <= reach ? [{ shipmentId: shipment.id, kind: 'route', reason: call ? `Reaches the upcoming ${call.name} call.` : 'Reaches the remaining planned sea corridor; arrival impact has not necessarily been assessed.' }] : [];
  const alternate: NewsRelevance[] = diversions.filter(option => option.shipmentId === shipment.id && (distanceToGeometryKm(notice.geometry, option.coordinates) ?? Infinity) <= reach).map(option => ({ shipmentId: shipment.id, kind: 'diversion', diversionId: option.id, reason: `Reaches ${option.name}, a possible alternative to ${ports.find(port => port.id === option.replaces)?.name}.` }));
  if (route.length || alternate.length) return [...route, ...alternate];
  return laneDistance <= Math.max(reach, 500) ? [{ shipmentId: shipment.id, kind: 'context', reason: 'Near the remaining voyage corridor, outside this notice’s declared reach. Context only.' }] : [];
};

/** Relevance is evidence selection, not a second risk/ETA assessment. */
export function buildIntelligence(shipments: readonly Shipment[], notices: readonly Notice[], now: Date, unavailableProviders: readonly string[] = [], sourcesEnabled = true, scope: 'voyage' | 'corridor' = 'voyage'): Intelligence {
  const diversions = shipments.flatMap(shipment => scope === 'voyage' ? diversionsFor(shipment, now) : [shipment.origin, shipment.destination].map(replaces => ({ ...options[replaces], id: `${shipment.id}:${replaces}`, shipmentId: shipment.id, replaces })));
  const items = new Map<string, IntelligenceItem>();
  for (const notice of notices.filter(notice => isActive(notice, now))) {
    const relevance = shipments.flatMap(shipment => relevanceFor(notice, shipment, diversions, now, scope));
    if (!relevance.length) continue;
    const coordinates = anchors(notice.geometry)[0] ?? (notice.geometry.kind === 'zone' ? ports.find(port => notice.geometry.kind === 'zone' && notice.geometry.portIds.includes(port.id))?.coordinates : undefined) ?? null;
    items.set(notice.id, { evidence: { id: notice.id, title: notice.title, detail: notice.detail, observedAt: notice.observedAt, source: 'live', provider: notice.provider, url: notice.url, ...(notice.report ? { report: notice.report } : {}) }, coordinates, relevance });
  }
  for (const shipment of shipments) for (const evidence of shipment.evidence) {
    const held = items.get(evidence.id);
    const relevance: NewsRelevance = { shipmentId: shipment.id, kind: 'route', reason: 'Retained evidence supporting this shipment’s assessment; see the observation time.' };
    items.set(evidence.id, { evidence: held?.evidence ?? evidence, coordinates: held?.coordinates ?? null, relevance: held?.relevance.some(item => item.shipmentId === shipment.id && item.kind === 'route') ? held.relevance : [...(held?.relevance ?? []), relevance] });
  }
  return { items: [...items.values()].sort((a, b) => Date.parse(b.evidence.observedAt) - Date.parse(a.evidence.observedAt)), diversions, checkedAt: now.toISOString(), unavailableProviders, sourcesEnabled };
}
