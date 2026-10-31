import { demoShipments, ports } from '../../domain';
import type { PortId } from '../../shared';
import { exposure, isActive, nearestPort, type Lane, type LaneHit, type Place, type PortHit } from './exposure';
import { fetchGdacs } from './gdacs';
import type { Fetcher } from './http';
import type { FetchResult, Notice, NoticeProvider } from './notice';
import { fetchNws } from './nws';
import { fetchUsgs } from './usgs';

export type Feed = Readonly<{ provider: NoticeProvider; fetch: (now: Date, fetcher: Fetcher) => Promise<FetchResult> }>;
export const feeds: readonly Feed[] = [{ provider: 'gdacs', fetch: fetchGdacs }, { provider: 'nws', fetch: fetchNws }, { provider: 'usgs', fetch: fetchUsgs }];

export const places: readonly Place[] = ports.map(port => ({ id: port.id, name: port.name, coordinates: port.coordinates }));
export const lanes = (now: Date): readonly Lane[] => demoShipments(now).map(shipment => ({ id: shipment.id, path: shipment.route }));

export type Sweep = Readonly<{ notices: readonly Notice[]; failures: readonly Extract<FetchResult, { status: 'unavailable' }>[] }>;
export type PortNotice = Readonly<{ notice: Notice; hit: PortHit; lanes: readonly LaneHit[] }>;

const settle = (results: readonly FetchResult[]): Sweep => ({
  notices: results.flatMap(result => result.status === 'ok' ? result.notices : []),
  failures: results.flatMap(result => result.status === 'unavailable' ? [result] : []),
});

export const sweep = async (now: Date, fetcher: Fetcher = fetch, selected: readonly Feed[] = feeds): Promise<Sweep> =>
  settle(await Promise.all(selected.map(feed => feed.fetch(now, fetcher).catch((error: unknown): FetchResult =>
    ({ status: 'unavailable', provider: feed.provider, message: `${feed.provider} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}` })))));

/**
 * Active notices one port agent publishes, nearest first: those that reach the port, and those that reach only a sea lane
 * when this is the nearest port to the notice, so exactly one agent reports each lane-only notice.
 */
export const noticesForPort = (notices: readonly Notice[], portId: PortId, now: Date, routes: readonly Lane[] = lanes(now)): readonly PortNotice[] =>
  notices.filter(notice => isActive(notice, now)).flatMap((notice): readonly PortNotice[] => {
    const reach = exposure(notice, places, routes);
    const hit = reach.ports.find(candidate => candidate.portId === portId);
    if (hit !== undefined) return [{ notice, hit, lanes: reach.lanes }];
    const nearest = reach.lanes.length > 0 ? nearestPort(notice, places) : null;
    return nearest !== null && nearest.place.id === portId
      ? [{ notice, hit: { portId, distanceKm: nearest.distanceKm, radiusKm: reach.lanes[0]?.radiusKm ?? 0, basis: 'nearest-to-lane' }, lanes: reach.lanes }] : [];
  }).toSorted((left, right) => left.hit.distanceKm - right.hit.distanceKm);

/** Feeds are polite public services: one sweep is shared by every port agent for `ttlMs`. */
export const cachedSweep = (ttlMs: number, fetcher: Fetcher = fetch, selected: readonly Feed[] = feeds) => {
  let held: Readonly<{ at: number; pending: Promise<Sweep> }> | null = null;
  return (now: Date): Promise<Sweep> => {
    if (held !== null && now.getTime() - held.at < ttlMs) return held.pending;
    const pending = sweep(now, fetcher, selected);
    held = { at: now.getTime(), pending };
    return pending;
  };
};

export const liveSweep = cachedSweep(5 * 60_000);

/** What a port agent asks on each alarm: failures are data, so this never rejects. */
export const pollPort = async (portId: PortId, now: Date = new Date(), enabled: boolean = process.env.GAZETTEER_LIVE_SOURCES !== 'off'): Promise<readonly PortNotice[]> =>
  enabled ? noticesForPort((await liveSweep(now)).notices, portId, now) : [];
