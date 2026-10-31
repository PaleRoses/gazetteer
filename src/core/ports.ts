/**
 * The one port registry. Ports, codes and coordinates are real; `serviceRate` is an assumption, declared as one:
 * departures per hour = the port's yearly container throughput / an assumed exchange per mainline call / 8,760 h.
 */
const teuPerCall = 4_000;
const hoursPerYear = 8_760;
const assumed = (millionTeu: number, year: number, complex?: string) => ({
  perHour: Math.round(millionTeu * 1e6 / teuPerCall / hoursPerYear * 100) / 100,
  provenance: 'assumed' as const,
  basis: `${year} throughput${complex ? ` of ${complex}` : ''} about ${millionTeu} M TEU, assumed ${teuPerCall.toLocaleString('en-US')} TEU exchanged per mainline call`,
});

export const ports = [
  { id: 'singapore', name: 'Singapore', country: 'Singapore', locode: 'SGSIN', coordinates: [103.82, 1.26], serviceRate: assumed(39.0, 2023) },
  { id: 'rotterdam', name: 'Rotterdam', country: 'Netherlands', locode: 'NLRTM', coordinates: [4.48, 51.92], serviceRate: assumed(13.4, 2023) },
  { id: 'shanghai', name: 'Shanghai', country: 'China', locode: 'CNSHA', coordinates: [121.5, 31.2], serviceRate: assumed(49.2, 2023) },
  { id: 'los-angeles', name: 'Los Angeles', country: 'United States', locode: 'USLAX', coordinates: [-118.26, 33.74], serviceRate: assumed(16.6, 2023, 'Los Angeles and Long Beach') },
  { id: 'ningbo-zhoushan', name: 'Ningbo-Zhoushan', country: 'China', locode: 'CNNGB', coordinates: [121.86, 29.93], serviceRate: assumed(35.3, 2023) },
  { id: 'busan', name: 'Busan', country: 'South Korea', locode: 'KRPUS', coordinates: [129.05, 35.08], serviceRate: assumed(23.0, 2023) },
  { id: 'port-klang', name: 'Port Klang', country: 'Malaysia', locode: 'MYPKG', coordinates: [101.33, 2.99], serviceRate: assumed(14.1, 2023) },
  { id: 'colombo', name: 'Colombo', country: 'Sri Lanka', locode: 'LKCMB', coordinates: [79.85, 6.95], serviceRate: assumed(6.9, 2023) },
  { id: 'jebel-ali', name: 'Jebel Ali', country: 'United Arab Emirates', locode: 'AEJEA', coordinates: [55.03, 25.01], serviceRate: assumed(14.5, 2023) },
  { id: 'antwerp', name: 'Antwerp-Bruges', country: 'Belgium', locode: 'BEANR', coordinates: [4.3, 51.28], serviceRate: assumed(12.5, 2023) },
  { id: 'piraeus', name: 'Piraeus', country: 'Greece', locode: 'GRPIR', coordinates: [23.62, 37.94], serviceRate: assumed(5.1, 2023) },
  { id: 'new-york-new-jersey', name: 'New York and New Jersey', country: 'United States', locode: 'USNYC', coordinates: [-74.14, 40.67], serviceRate: assumed(7.8, 2023) },
  { id: 'savannah', name: 'Savannah', country: 'United States', locode: 'USSAV', coordinates: [-81.1, 32.08], serviceRate: assumed(4.9, 2023) },
  { id: 'santos', name: 'Santos', country: 'Brazil', locode: 'BRSSZ', coordinates: [-46.3, -23.96], serviceRate: assumed(5.0, 2023) },
] as const;

type PortEntry = (typeof ports)[number];
export type PortId = PortEntry['id'];
export const portIds: readonly PortId[] = ports.map(port => port.id);
export const portById: ReadonlyMap<PortId, PortEntry> = new Map(ports.map(port => [port.id, port]));
