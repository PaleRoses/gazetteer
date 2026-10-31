import { distanceKm } from '../sources/geo';
import { gfwDefaults } from '../telemetry/gfw';
import { gate, memory, ring as ringLimits } from './constants';
import { bump, emptyCounts, step, type Counts, type VesselState } from './anchorage';
import { isCargoOrTanker, validFrame, type FeedEvent, type Frame } from './frame';
import { createRing, type Ring } from './ring';
import { buildRouter, type PortArea, type ZoneRef } from './zones';

export type Subscriber = Readonly<{ workspaceId: string; shipmentId: string }>;
type Delivery = Readonly<{ subscribers: readonly Subscriber[]; frame: Frame }>;
type Traffic = Readonly<{ portId: string; at: number; anchored: number; berthed: number; approach: number }>;
export type Flush = Readonly<{ deliveries: readonly Delivery[]; traffic: readonly Traffic[] }>;
type Stats = Readonly<{ received: number; invalid: number; routed: number; unclassified: number; tracked: number; vessels: number; rings: number; active: number }>;

export type Ingest = Readonly<{
  push: (event: FeedEvent) => void;
  track: (mmsi: number, subscriber: Subscriber) => void;
  untrack: (mmsi: number, subscriber: Subscriber) => void;
  latest: (mmsi: number) => Frame | undefined;
  ring: (mmsi: number) => Ring | undefined;
  counts: (portId: string) => Readonly<Counts>;
  flush: (now: number) => Flush;
  stats: () => Stats;
  /** The newest `max` vessels whose latest fix is within `withinSeconds` of `now`, newest first, each with the zone it is in. */
  recent: (now: number, max: number, withinSeconds: number) => readonly Readonly<{ frame: Frame; zone: ZoneRef | undefined }>[];
}>;

const moving = (frame: Frame): boolean => (frame.sogKnots ?? 0) >= gfwDefaults.startingKnots;
const metersBetween = (a: Frame, b: Frame): number => distanceKm([a.lon, a.lat], [b.lon, b.lat]) * 1000;

/**
 * The synchronous core. Stateful by obligation (a hot path that allocates per message is the defect): every map is bounded, by the
 * tracked set, by the port areas, or by a TTL/capacity eviction that pops the recency-ordered front. `now` is always an argument, so
 * replay, bench and production run this same code.
 */
export const createIngest = (config: Readonly<{ ports: readonly PortArea[] }>): Ingest => {
  const router = buildRouter(config.ports);
  const subscribers = new Map<number, Subscriber[]>();
  const latestFix = new Map<number, Frame>();
  const delivered = new Map<number, Frame>();
  const rings = new Map<number, Ring>();
  const dirty = new Set<number>();
  const vessels = new Map<number, VesselState>();
  /** Every valid MMSI the feed carried in the last hour, with its latest fix; recency-ordered (delete + set) so eviction pops the front and the newest are at the back. */
  const active = new Map<number, Frame>();
  const shipTypes = new Map<number, number>();
  const counts = new Map<string, Counts>(config.ports.map(port => [port.id, emptyCounts()]));
  const reported = new Map<string, Traffic>();
  const tally = { received: 0, invalid: 0, routed: 0, unclassified: 0 };

  const countsOf = (portId: string): Counts => counts.get(portId) ?? emptyCounts();

  /** A tracked vessel's frame: conflate, ring, and mark dirty only when the change is one an actor should hear about. */
  const follow = (frame: Frame): void => {
    const last = latestFix.get(frame.mmsi);
    if (last && frame.at <= last.at) return;
    latestFix.set(frame.mmsi, frame);
    const ring = rings.get(frame.mmsi) ?? (() => {
      const created = createRing();
      rings.set(frame.mmsi, created);
      const oldest = rings.size > ringLimits.maxRings ? rings.keys().next().value : undefined;
      if (oldest !== undefined) rings.delete(oldest);
      return created;
    })();
    ring.add(frame);
    const sent = delivered.get(frame.mmsi);
    if (!sent || frame.at - sent.at >= gate.heartbeatSeconds || frame.navStatus !== sent.navStatus
      || moving(frame) !== moving(sent) || metersBetween(sent, frame) >= gate.significantMoveMeters) dirty.add(frame.mmsi);
  };

  const classify = (frame: Frame): void => {
    const previous = vessels.get(frame.mmsi);
    const zone = router.route(frame.lat, frame.lon);
    if (!zone && !previous) return;
    tally.routed += 1;
    if (!isCargoOrTanker(shipTypes.get(frame.mmsi))) { tally.unclassified += 1; return; }
    const next = step(previous, zone, frame);
    if (next === previous) return;
    if (previous) { bump(countsOf(previous.portId), previous, -1); vessels.delete(frame.mmsi); }
    if (next) { bump(countsOf(next.portId), next, 1); vessels.set(frame.mmsi, next); }
  };

  const evict = (now: number): void => {
    const activeHorizon = now - memory.activeWindowSeconds;
    for (const [mmsi, fix] of active) {
      if (fix.at >= activeHorizon) break;
      active.delete(mmsi);
    }
    const horizon = now - memory.vesselTtlSeconds;
    for (const [mmsi, state] of vessels) {
      if (state.at >= horizon) break;
      bump(countsOf(state.portId), state, -1);
      vessels.delete(mmsi);
    }
  };

  return {
    push: event => {
      if (event.kind === 'invalid') { tally.invalid += 1; return; }
      if (event.kind === 'static') {
        shipTypes.delete(event.mmsi);
        shipTypes.set(event.mmsi, event.shipType);
        const oldest = shipTypes.size > memory.shipTypeCapacity ? shipTypes.keys().next().value : undefined;
        if (oldest !== undefined) shipTypes.delete(oldest);
        return;
      }
      tally.received += 1;
      if (!validFrame(event.frame)) { tally.invalid += 1; return; }
      active.delete(event.frame.mmsi);
      active.set(event.frame.mmsi, event.frame);
      if (subscribers.has(event.frame.mmsi)) follow(event.frame);
      classify(event.frame);
    },
    track: (mmsi, subscriber) => { subscribers.set(mmsi, [...(subscribers.get(mmsi) ?? []).filter(item => item.shipmentId !== subscriber.shipmentId || item.workspaceId !== subscriber.workspaceId), subscriber]); },
    untrack: (mmsi, subscriber) => {
      const rest = (subscribers.get(mmsi) ?? []).filter(item => item.shipmentId !== subscriber.shipmentId || item.workspaceId !== subscriber.workspaceId);
      if (rest.length > 0) { subscribers.set(mmsi, rest); return; }
      [subscribers, latestFix, delivered, rings].forEach(map => map.delete(mmsi));
      dirty.delete(mmsi);
    },
    latest: mmsi => latestFix.get(mmsi),
    ring: mmsi => rings.get(mmsi),
    counts: portId => countsOf(portId),
    flush: now => {
      evict(now);
      const deliveries = [...dirty].flatMap(mmsi => {
        const frame = latestFix.get(mmsi);
        const to = subscribers.get(mmsi);
        if (frame) delivered.set(mmsi, frame);
        return frame && to ? [{ subscribers: to, frame }] : [];
      });
      dirty.clear();
      const traffic = config.ports.flatMap(port => {
        const now_ = countsOf(port.id);
        const before = reported.get(port.id);
        if (before && before.anchored === now_.anchored && before.berthed === now_.berthed && before.approach === now_.approach && now - before.at < gate.heartbeatSeconds) return [];
        const snapshot = { portId: port.id, at: now, ...now_ };
        reported.set(port.id, snapshot);
        return [snapshot];
      });
      return { deliveries, traffic };
    },
    recent: (now, max, withinSeconds) => [...active.values()].filter(fix => fix.at >= now - withinSeconds).slice(-max).reverse().map(frame => ({ frame, zone: router.route(frame.lat, frame.lon) })),
    stats: () => ({ ...tally, tracked: subscribers.size, vessels: vessels.size, rings: rings.size, active: active.size }),
  };
};
