import { describe, expect, test } from 'bun:test';
import type { BoardMessage, PortBulletin } from '../../../../src/core/board';
import { demoShipments } from '../../../../src/core/demo';
import { portById } from '../../../../src/core/ports';
import { type AssessedShipment } from '../../../../src/server/assessment/apply';
import { react, queueDrain, type Reactions } from '../../../../src/server/agents/ship/react';
import { applyFloor, floorRules, riskFloor } from '../../../../src/server/agents/ship/risk-floor';
import type { Signal } from '../../../../src/server/telemetry/watcher';
import type { Telemetry } from '../../../../src/server/telemetry/telemetry';

const now = '2026-10-31T12:00:00.000Z';
const [meridian] = demoShipments(new Date(now)) as [AssessedShipment, ...AssessedShipment[]];
const rate = portById.get('singapore')!.serviceRate.perHour;
const own = 'obs:telemetry:gz-1042:stationary-outside-port:t1';
const bulletin = (over: Partial<PortBulletin> & Pick<PortBulletin, 'id'>): PortBulletin => ({
  kind: 'port.bulletin', author: { role: 'port', id: 'singapore' }, at: now, summary: 'Singapore.', portId: 'singapore', risk: 'severe', anchored: 10, arrivals48h: 0, evidenceIds: [], ...over,
});
const ahead = (anchored: number): number => Math.round(Math.min(queueDrain.capHours.value, anchored / rate));
const telemetry: Telemetry = { mmsi: '563012345', position: [103.9, 1.3], sogKnots: 0, cogDegrees: 90, navStatus: 1, observedAt: now, provenance: 'live', provider: 'aisstream', fetchedAt: now };
const signal = (kind: Signal['kind'], measured: Signal['measured']): Signal => ({ id: `563012345:${kind}:t`, kind, title: kind, detail: '', observedAt: now, provenance: 'live', provider: 'aisstream', fetchedAt: now, measured, thresholds: {}, telemetry });
const hours = (from: string, to: string): number => (Date.parse(to) - Date.parse(from)) / 3_600_000;

describe('ship reaction to a port bulletin', () => {
  test('the delay is the queue ahead over the port service rate, minus this ship if it is in that queue', () => {
    const board: BoardMessage[] = [bulletin({ id: 'b1', anchored: 11, evidenceIds: [own] })];
    const reacted = react(meridian, board, {}, own, now);
    expect(reacted.reactions.singapore).toEqual({ bulletinId: 'b1', hours: ahead(10) });
    expect(hours(meridian.eta, reacted.shipment.eta)).toBe(ahead(10));
    expect(reacted.changed[0]).toMatchObject({ rule: 'queue-drain', portId: 'singapore', bulletinId: 'b1', anchored: 10, serviceRate: { departuresPerHour: rate, provenance: 'assumed' } });
    expect(reacted.summary.watching).toContain('b1');
    expect(ahead(10)).toBeGreaterThan(0);
  });

  test('only the ships queued before this one are waited for: the head of the queue waits for no one', () => {
    const ship = (id: string, at: string): BoardMessage => ({ id, kind: 'ship.observation', author: { role: 'ship', id, vessel: id }, at, summary: 's', shipmentId: id, signals: ['stationary-outside-port'], position: [103.9, 1.2], nearPort: 'singapore', provider: 'test', observedAt: at });
    const first = ship('obs:first', '2026-10-31T10:00:00.000Z');
    const second = ship('obs:second', '2026-10-31T11:00:00.000Z');
    const board: BoardMessage[] = [first, second, bulletin({ id: 'b', anchored: 2, evidenceIds: ['obs:first', 'obs:second'] })];
    expect(react(meridian, board, {}, 'obs:first', now).shipment).toBe(meridian);
    expect(react(meridian, board, {}, 'obs:second', now).reactions.singapore?.hours).toBe(ahead(1));
    expect(react(meridian, board, {}, null, now).reactions.singapore?.hours).toBe(ahead(2));
  });

  test('a city watch is heard like a bulletin: traffic sets the delay, hazards only a watch and never undo it', () => {
    const traffic: BoardMessage = { id: 'city:t', kind: 'city.traffic', author: { role: 'city', city: 'singapore', element: 'traffic' }, at: now, summary: 's', risk: 'severe', anchored: 10, arrivals48h: 0, evidenceIds: [], basis: { perHour: rate, provenance: 'assumed', basis: 'b' } };
    const hazard: BoardMessage = { id: 'city:h', kind: 'city.hazards', author: { role: 'city', city: 'singapore', element: 'hazards' }, at: '2026-10-31T12:10:00.000Z', summary: 's', risk: 'elevated', notices: [], evidenceIds: [] };
    const heard = react(meridian, [traffic, hazard], {}, null, '2026-10-31T12:10:00.000Z');
    expect(heard.reactions.singapore).toEqual({ bulletinId: 'city:t', hours: ahead(10) });
    expect(heard.summary.watching).toEqual(expect.arrayContaining(['city:t', 'city:h']));
    const alone = react(meridian, [hazard], {}, null, '2026-10-31T12:10:00.000Z');
    expect(alone.shipment).toBe(meridian);
    expect(alone.summary.watching).toEqual(['city:h']);
  });

  test('a veteran that has loitered longest is the head of the queue even when the report does not list it', () => {
    const stop = (id: string, at: string, loiteringHours: number): BoardMessage => ({ id, kind: 'ship.observation', author: { role: 'ship', id, vessel: id }, at, summary: 's', shipmentId: id, signals: ['stationary-outside-port'], measured: { loiteringHours }, position: [103.9, 1.2], nearPort: 'singapore', provider: 'test', observedAt: at });
    const veteran = stop('obs:veteran', '2026-10-31T11:59:00.000Z', 15);
    const board: BoardMessage[] = [veteran, stop('obs:a', '2026-10-31T10:00:00.000Z', 3), stop('obs:b', '2026-10-31T10:00:00.000Z', 1), bulletin({ id: 'b', anchored: 2, evidenceIds: ['obs:a', 'obs:b'] })];
    expect(react(meridian, board, {}, 'obs:veteran', now).shipment).toBe(meridian);
    expect(react(meridian, board, {}, 'obs:a', now).shipment).toBe(meridian);
    expect(react(meridian, board, {}, 'obs:b', now).reactions.singapore?.hours).toBe(ahead(1));
  });

  test('the same bulletin changes nothing and a shorter queue relaxes the estimate; the delay is set, not added', () => {
    const first = react(meridian, [bulletin({ id: 'b1', anchored: 20 })], {}, null, now);
    const again = react(first.shipment, [bulletin({ id: 'b1', anchored: 20 })], first.reactions, null, now);
    expect(again.shipment).toBe(first.shipment);
    expect(again.changed).toEqual([]);
    const shorter = react(first.shipment, [bulletin({ id: 'b2', at: '2026-10-31T12:30:00.000Z', anchored: 8 })], first.reactions, null, '2026-10-31T12:30:00.000Z');
    expect(shorter.shipment.delayHours).toBe(meridian.delayHours + ahead(8));
    expect(shorter.shipment.delayHours).toBeLessThan(first.shipment.delayHours);
    const cleared = react(shorter.shipment, [bulletin({ id: 'b3', at: '2026-10-31T13:00:00.000Z', anchored: 0, risk: 'normal' })], shorter.reactions, null, '2026-10-31T13:00:00.000Z');
    expect(cleared.shipment.eta).toBe(meridian.eta);
  });

  test('a hazard-only or arrivals-only bulletin is a watch and leaves the ETA alone; so does a queue past the window', () => {
    const hazard = react(meridian, [bulletin({ id: 'h', anchored: 0, risk: 'elevated' })], {}, null, now);
    expect(hazard.shipment).toBe(meridian);
    expect(hazard.summary).toEqual({ watching: ['h'], hours: 0 });
    const far = react({ ...meridian, milestones: meridian.milestones.map(m => m.label === 'Transshipment berth' ? { ...m, at: '2026-11-10T00:00:00.000Z' } : m) }, [bulletin({ id: 'f' })], {}, null, now);
    expect(far.shipment.eta).toBe(meridian.eta);
    expect(far.summary.watching).toEqual(['f']);
    const closer = react(meridian, [bulletin({ id: 'f' })], far.reactions, null, now);
    expect(closer.shipment).toBe(meridian);
    expect(react(meridian, [bulletin({ id: 'f2' })], far.reactions, null, now).shipment.eta).not.toBe(meridian.eta);
  });

  test('the delay is capped, and only the newest bulletin of a port inside the horizon counts', () => {
    const capped = react(meridian, [bulletin({ id: 'huge', anchored: 5000 })], {}, null, now);
    expect(capped.reactions.singapore?.hours).toBe(queueDrain.capHours.value);
    const older = react(meridian, [bulletin({ id: 'old', at: '2026-10-31T11:00:00.000Z', anchored: 100 }), bulletin({ id: 'new', anchored: 2 })], {}, null, now);
    expect(older.reactions.singapore?.bulletinId).toBe('new');
    const stale = react(meridian, [bulletin({ id: 'stale', at: '2026-10-29T11:00:00.000Z', anchored: 100 })], {}, null, now);
    expect(stale.shipment).toBe(meridian);
  });

  test('a port already behind the ship is ignored', () => {
    const done = react(meridian, [bulletin({ id: 'sh', portId: 'shanghai', author: { role: 'port', id: 'shanghai' } })], {} as Reactions, null, now);
    expect(done.shipment).toBe(meridian);
    expect(done.summary).toEqual({ watching: [], hours: 0 });
  });
});

describe('rule-based risk floor', () => {
  test('any active signal is at least a watch and nothing active is no floor', () => {
    expect(riskFloor([signal('off-route', { offRouteKm: 80 })])?.risk).toBe('watch');
    expect(riskFloor([signal('ais-dark', {})])?.risk).toBe('watch');
    expect(riskFloor([])).toBeNull();
  });
  test('a stop past the loitering rule or a slip past the slip rule is delayed, and just under is a watch', () => {
    const stop = (loiteringHours: number) => riskFloor([signal('stationary-outside-port', { loiteringHours })])?.risk;
    expect(stop(floorRules.loiteringHours.value)).toBe('delayed');
    expect(stop(floorRules.loiteringHours.value - 0.1)).toBe('watch');
    const slip = (projectedSlipHours: number) => riskFloor([signal('slow-steaming', { projectedSlipHours })])?.risk;
    expect(slip(floorRules.projectedSlipHours.value + 0.1)).toBe('delayed');
    expect(slip(floorRules.projectedSlipHours.value)).toBe('watch');
  });
  test('a reaction is a watch, a day of queue is delayed, and the floor only raises the base risk', () => {
    expect(riskFloor([], { watching: ['b'], hours: 0 })?.risk).toBe('watch');
    expect(riskFloor([], { watching: ['b'], hours: floorRules.reactionDelayedHours.value })?.risk).toBe('delayed');
    expect(applyFloor('delayed', riskFloor([signal('off-route', {})]))).toBe('delayed');
    expect(applyFloor('on-track', riskFloor([signal('off-route', {})]))).toBe('watch');
    expect(applyFloor('watch', null)).toBe('watch');
    expect(riskFloor([signal('off-route', {})])?.citedEvidence).toEqual(['563012345:off-route:t']);
  });
});
