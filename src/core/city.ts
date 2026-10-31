import type { BoardMessage, CityAgent, CityElement, CityReport, PortRisk, PortStatus } from './board.js';
import type { PortId } from './ports.js';
import { servicesAt } from './services.js';
import type { Shipment } from './types.js';

/** The elements a city's watches grade, one durable agent each. */
export const cityElements = ['traffic', 'hazards'] as const satisfies readonly CityElement[];

/** Upcoming calls only: the origin has departed, the same rule the assessor and the deterministic model use. */
export const relevance = (shipments: readonly Shipment[], city: PortId): number =>
  shipments.filter(shipment => shipment.destination === city || shipment.via.includes(city)).length;

const isReport = (message: BoardMessage): message is CityReport => message.kind === 'city.traffic' || message.kind === 'city.hazards';
const newest = <A extends BoardMessage>(messages: readonly A[]): A | null =>
  messages.reduce<A | null>((latest, message) => latest === null || message.at >= latest.at ? message : latest, null);

export const latestReport = (board: readonly BoardMessage[], city: PortId, element: CityElement): CityReport | null =>
  newest(board.filter(isReport).filter(report => report.author.city === city && report.author.element === element));

type Service = ReturnType<typeof servicesAt>[number];
const postedBy = (city: PortId, service: Service) => (message: BoardMessage): boolean =>
  service === 'haulier' ? message.author.role === 'haulier' && message.author.city === city
    : message.author.role === 'city' && message.author.city === city && message.author.element === service;

const rank: Readonly<Record<PortRisk, number>> = { normal: 0, elevated: 1, severe: 2 };
const worst = (risks: readonly PortRisk[]): PortRisk => risks.reduce<PortRisk>((held, risk) => rank[risk] > rank[held] ? risk : held, 'normal');

/**
 * A city's risk is not an agent's opinion: it is the worst of what its watches last reported. A watch that has said nothing is normal
 * by construction, because each one reports every change. The services stationed there (the terminal desk, the haulier) are listed
 * with their latest post and grade nothing.
 */
export const cityStatuses = (cities: readonly Readonly<{ id: PortId }>[], shipments: readonly Shipment[], board: readonly BoardMessage[]): readonly PortStatus[] =>
  cities.map(city => {
    const relevant = relevance(shipments, city.id);
    const watches = relevant > 0 ? cityElements.map(element => {
      const latest = latestReport(board, city.id, element);
      return { element, risk: latest?.risk ?? 'normal', latest: latest?.id ?? null } as const;
    }) : [];
    const services: readonly CityAgent[] = relevant > 0 ? servicesAt(city.id).map(service => ({ element: service, risk: null, latest: newest(board.filter(postedBy(city.id, service)))?.id ?? null })) : [];
    return { portId: city.id, risk: worst(watches.map(watch => watch.risk)), relevance: relevant, bulletin: null, agents: [...watches, ...services] };
  });
