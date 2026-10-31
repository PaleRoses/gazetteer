import type { BoardMessage, CityAgent, CityElement, CityReport, PortRisk, PortStatus } from './board.js';
import type { PortId } from './ports.js';
import type { Shipment } from './types.js';

/** The elements a city's agents watch, one durable agent each. */
export const cityElements = ['traffic', 'hazards'] as const satisfies readonly CityElement[];

/** Upcoming calls only: the origin has departed, the same rule the assessor and the deterministic model use. */
export const relevance = (shipments: readonly Shipment[], city: PortId): number =>
  shipments.filter(shipment => shipment.destination === city || shipment.via.includes(city)).length;

const isReport = (message: BoardMessage): message is CityReport => message.kind === 'city.traffic' || message.kind === 'city.hazards';

export const latestReport = (board: readonly BoardMessage[], city: PortId, element: CityElement): CityReport | null =>
  board.filter(isReport).filter(report => report.author.city === city && report.author.element === element)
    .reduce<CityReport | null>((latest, report) => latest === null || report.at >= latest.at ? report : latest, null);

const rank: Readonly<Record<PortRisk, number>> = { normal: 0, elevated: 1, severe: 2 };
const worst = (risks: readonly PortRisk[]): PortRisk => risks.reduce<PortRisk>((held, risk) => rank[risk] > rank[held] ? risk : held, 'normal');

/**
 * A city's risk is not an agent's opinion: it is the worst of what its agents last reported. An agent that has said nothing is
 * normal by construction, because each one reports every change.
 */
export const cityStatuses = (cities: readonly Readonly<{ id: PortId }>[], shipments: readonly Shipment[], board: readonly BoardMessage[]): readonly PortStatus[] =>
  cities.map(city => {
    const relevant = relevance(shipments, city.id);
    const agents: CityAgent[] = relevant > 0 ? cityElements.map(element => {
      const latest = latestReport(board, city.id, element);
      return { element, risk: latest?.risk ?? 'normal', latest: latest?.id ?? null };
    }) : [];
    return { portId: city.id, risk: worst(agents.map(agent => agent.risk)), relevance: relevant, bulletin: null, agents };
  });
