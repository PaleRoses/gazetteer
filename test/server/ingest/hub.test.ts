import { describe, expect, test } from 'bun:test';
import { anchoredMinDwellSeconds, gate, memory, ring } from '../../../src/server/ingest/constants';
import { createIngest } from '../../../src/server/ingest/hub';
import { at, cargo, frame, laPort } from './fixtures';

const subscriber = { workspaceId: 'w', shipmentId: 's' };
const position = (...args: Parameters<typeof frame>) => ({ kind: 'position', frame: frame(...args) }) as const;
const known = (mmsi: number, shipType = cargo) => ({ kind: 'static', mmsi, shipType }) as const;
const fresh = () => createIngest({ ports: [laPort] });

describe('port counts over all traffic', () => {
  test('counters follow each vessel through approach, anchored and gone, and never go negative', () => {
    const ingest = fresh();
    ingest.push(known(367000001));
    ingest.push(position(367000001, 1_000, at.anchorage));
    expect(ingest.counts('los-angeles')).toEqual({ anchored: 0, berthed: 0, approach: 1 });
    ingest.push(position(367000001, 1_000 + anchoredMinDwellSeconds, at.anchorage));
    expect(ingest.counts('los-angeles')).toEqual({ anchored: 1, berthed: 0, approach: 0 });
    ingest.push(position(367000001, 9_000, at.open, 12));
    expect(ingest.counts('los-angeles')).toEqual({ anchored: 0, berthed: 0, approach: 0 });
    expect(ingest.stats().vessels).toBe(0);
  });

  test('only cargo and tanker types are counted; the rest is reported as unclassified', () => {
    const ingest = fresh();
    ingest.push(known(367000002, 30));
    ingest.push(position(367000002, 1_000, at.berth));
    ingest.push(position(367000003, 1_000, at.berth));
    expect(ingest.counts('los-angeles').berthed).toBe(0);
    expect(ingest.stats().unclassified).toBe(2);
  });

  test('a silent vessel is dropped from the count after the TTL, and a live one is not', () => {
    const ingest = fresh();
    ingest.push(known(367000004)); ingest.push(known(367000005));
    ingest.push(position(367000004, 1_000, at.berth));
    ingest.push(position(367000005, 1_000 + memory.vesselTtlSeconds, at.berth));
    ingest.flush(1_000 + memory.vesselTtlSeconds + 1);
    expect(ingest.counts('los-angeles').berthed).toBe(1);
    expect(ingest.stats().vessels).toBe(1);
  });

  test('traffic is reported when a counter changed or on the heartbeat, and not otherwise', () => {
    const ingest = fresh();
    expect(ingest.flush(100).traffic).toHaveLength(1);
    expect(ingest.flush(105).traffic).toHaveLength(0);
    ingest.push(known(367000006)); ingest.push(position(367000006, 110, at.berth));
    expect(ingest.flush(115).traffic[0]).toMatchObject({ portId: 'los-angeles', berthed: 1 });
    expect(ingest.flush(120).traffic).toHaveLength(0);
    expect(ingest.flush(115 + gate.heartbeatSeconds).traffic).toHaveLength(1);
  });

  test('invalid frames are counted and change nothing', () => {
    const ingest = fresh();
    ingest.push(position(12, 1_000, at.berth));
    ingest.push(position(367000007, 1_000, [-118.26, 91]));
    ingest.push({ kind: 'invalid' });
    expect(ingest.stats()).toMatchObject({ received: 2, invalid: 3, vessels: 0 });
  });
});

describe('tracked vessels', () => {
  const mmsi = 367000010;
  const tracked = () => { const ingest = fresh(); ingest.track(mmsi, subscriber); return ingest; };

  test('untracked traffic outside every port box leaves no trace', () => {
    const ingest = fresh();
    ingest.push(position(367000011, 1_000, [10, 50]));
    expect(ingest.latest(367000011)).toBeUndefined();
    expect(ingest.stats()).toMatchObject({ routed: 0, vessels: 0, rings: 0 });
  });

  test('a flush delivers the latest fix once, to every subscriber, and nothing when nothing changed', () => {
    const ingest = tracked();
    ingest.track(mmsi, { workspaceId: 'w2', shipmentId: 's2' });
    ingest.push(position(mmsi, 1_000, [10, 50], 10));
    ingest.push(position(mmsi, 1_010, [10.5, 50], 10));
    const first = ingest.flush(1_020).deliveries;
    expect(first).toHaveLength(1);
    expect(first[0]!.frame.at).toBe(1_010);
    expect(first[0]!.subscribers).toHaveLength(2);
    expect(ingest.flush(1_025).deliveries).toHaveLength(0);
  });

  test('small movements are not delivered; a large one, a stop and the heartbeat are', () => {
    const ingest = tracked();
    ingest.push(position(mmsi, 1_000, [10, 50], 10)); ingest.flush(1_001);
    ingest.push(position(mmsi, 1_010, [10.0001, 50], 10));
    expect(ingest.flush(1_020).deliveries).toHaveLength(0);
    ingest.push(position(mmsi, 1_030, [10.01, 50], 10));
    expect(ingest.flush(1_040).deliveries).toHaveLength(1);
    ingest.push(position(mmsi, 1_050, [10.01, 50], 0.1));
    expect(ingest.flush(1_060).deliveries).toHaveLength(1);
    ingest.push(position(mmsi, 1_060 + gate.heartbeatSeconds, [10.01, 50], 0.1));
    expect(ingest.flush(1_070 + gate.heartbeatSeconds).deliveries).toHaveLength(1);
  });

  test('an older frame never replaces a newer one', () => {
    const ingest = tracked();
    ingest.push(position(mmsi, 2_000, [10, 50])); ingest.push(position(mmsi, 1_000, [11, 50]));
    expect(ingest.latest(mmsi)?.at).toBe(2_000);
  });

  test('untracking forgets the vessel entirely', () => {
    const ingest = tracked();
    ingest.push(position(mmsi, 1_000, [10, 50]));
    ingest.untrack(mmsi, subscriber);
    expect(ingest.latest(mmsi)).toBeUndefined();
    expect(ingest.ring(mmsi)).toBeUndefined();
  });

  test('the ring keeps one point a minute, wraps at a day, and the set of rings is bounded', () => {
    const ingest = tracked();
    Array.from({ length: ring.capacity + 10 }, (_, index) => ingest.push(position(mmsi, 1_000 + index * ring.stepSeconds, [10, 50], 10)));
    ingest.push(position(mmsi, 1_000 + (ring.capacity + 9) * ring.stepSeconds + 5, [10, 50], 10));
    const points = ingest.ring(mmsi)!.points();
    expect(points).toHaveLength(ring.capacity);
    expect(points[0]!.at).toBe(1_000 + 10 * ring.stepSeconds);
    expect(points.every((point, index) => index === 0 || point.at > points[index - 1]!.at)).toBe(true);
    Array.from({ length: ring.maxRings + 50 }, (_, index) => { ingest.track(368_000_000 + index, subscriber); ingest.push(position(368_000_000 + index, 5_000, [10, 50])); });
    expect(ingest.stats().rings).toBe(ring.maxRings);
  });
});

describe('the active-vessel window', () => {
  test('counts every valid vessel the feed carried in the last hour, in or out of a port, and forgets the silent ones', () => {
    const ingest = fresh();
    ingest.push(position(367000030, 1_000, [10, 50])); ingest.push(position(367000031, 1_000 + memory.activeWindowSeconds, at.berth));
    expect(ingest.stats().active).toBe(2);
    ingest.flush(1_000 + memory.activeWindowSeconds + 1);
    expect(ingest.stats().active).toBe(1);
  });
});
