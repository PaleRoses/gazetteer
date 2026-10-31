import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBoardMessage, type EtaNotice, type PortBulletin, type ShipObservation } from '../src/board';
import { demoShipments, ports } from '../src/domain';
import { decideBulletin } from '../src/server/port/bulletin';
import { anchoredShips, arrivalsDue, assessPort, countLevel, bands, noticeLevel, type PortInputs } from '../src/server/port/risk';
import { latestBulletin, portStatuses, relevance } from '../src/server/port/status';
import { noticesForPort, type PortNotice } from '../src/server/sources';
import type { Notice, NoticeSeverity } from '../src/server/sources/notice';
import { normalizeNws } from '../src/server/sources/nws';
import type { PortHit } from '../src/server/sources/exposure';

const now = new Date('2026-10-31T20:00:00.000Z');
const rotterdam = ports.find(port => port.id === 'rotterdam')!;
const at = (hoursAgo: number): string => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
const north = (km: number): [number, number] => [rotterdam.coordinates[0], rotterdam.coordinates[1] + km / 111.195];

const observation = (shipmentId: string, overrides: Partial<ShipObservation> = {}): ShipObservation => ({
  id: `${shipmentId}:obs:${overrides.observedAt ?? 'x'}`, kind: 'ship.observation', author: { role: 'ship', id: shipmentId, vessel: shipmentId },
  at: at(1), summary: 'stopped', shipmentId, signals: ['stationary-outside-port'], position: north(20), nearPort: 'rotterdam', provider: 'test', observedAt: at(2), ...overrides,
});
const eta = (shipmentId: string, hoursAhead: number, overrides: Partial<EtaNotice> = {}): EtaNotice => ({
  id: `${shipmentId}:eta:${hoursAhead}`, kind: 'ship.eta', author: { role: 'ship', id: shipmentId, vessel: shipmentId }, at: at(1), summary: 'eta',
  shipmentId, portId: 'rotterdam', eta: new Date(now.getTime() + hoursAhead * 3_600_000).toISOString(), previousEta: at(0), ...overrides,
});
const notice = (severity: NoticeSeverity): Notice => ({
  id: `test:${severity}`, provider: 'gdacs', kind: 'cyclone', severity, title: `A ${severity} cyclone`, detail: '', observedAt: at(1), expiresAt: null,
  geometry: { kind: 'point', coordinates: [0, 0] }, url: 'https://example.invalid', fetchedAt: at(0), provenance: 'live',
});
const hazard = (severity: NoticeSeverity, distanceKm: number, basis: PortHit['basis'] = 'distance'): PortNotice => ({
  notice: notice(severity), hit: { portId: 'rotterdam', distanceKm, radiusKm: 600, basis }, lanes: [],
});
const inputs = (overrides: Partial<PortInputs> = {}): PortInputs => ({
  portId: 'rotterdam', coordinates: rotterdam.coordinates, now, notices: [], observations: [], etas: [], previous: null, ...overrides,
});

describe('live hazards', () => {
  test('severity sets the level and a notice off-centre loses a step; minor never raises it', () => {
    expect(noticeLevel(hazard('severe', 100))).toBe(2);
    expect(noticeLevel(hazard('severe', 400))).toBe(1);
    expect(noticeLevel(hazard('extreme', 400))).toBe(2);
    expect(noticeLevel(hazard('moderate', 100))).toBe(1);
    expect(noticeLevel(hazard('moderate', 0, 'nearest-to-lane'))).toBe(0);
    expect(noticeLevel(hazard('minor', 0, 'declared-zone'))).toBe(0);
  });

  test('the recorded Los Angeles marine statement is minor and leaves the port normal', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, 'fixtures/sources/nws-alerts-la.json'), 'utf8')) as unknown;
    const reaching = noticesForPort(normalizeNws(fixture, now.toISOString()), 'los-angeles', now);
    expect(reaching).toHaveLength(1);
    const la = ports.find(port => port.id === 'los-angeles')!;
    const assessed = assessPort({ ...inputs({ portId: 'los-angeles', coordinates: la.coordinates }), notices: reaching });
    expect(assessed.risk).toBe('normal');
    expect(assessed.hazard).toBe(0);
  });
});

describe('anchored ships', () => {
  test('counts a ship whose latest observation is stationary near this port, and only that', () => {
    const stopped = observation('a');
    const other = observation('b', { nearPort: 'singapore' });
    const stale = observation('c', { observedAt: at(30) });
    const moving = observation('d', { signals: ['slow-steaming'] });
    const resumed = [observation('e', { observedAt: at(5) }), observation('e', { signals: ['off-route'], observedAt: at(2) })];
    expect(anchoredShips([stopped, other, stale, moving, ...resumed], 'rotterdam', rotterdam.coordinates, now, []).map(ship => ship.shipmentId)).toEqual(['a']);
  });

  test('GFW hysteresis on distance: 35 km is outside the 30 km entry unless the ship was already anchored (exit is 40 km)', () => {
    const drifting = observation('a', { position: north(35) });
    expect(anchoredShips([drifting], 'rotterdam', rotterdam.coordinates, now, [])).toEqual([]);
    expect(anchoredShips([drifting], 'rotterdam', rotterdam.coordinates, now, ['a']).map(ship => ship.shipmentId)).toEqual(['a']);
    expect(anchoredShips([observation('a', { position: north(45) })], 'rotterdam', rotterdam.coordinates, now, ['a'])).toEqual([]);
  });
});

describe('arrivals', () => {
  test('counts ETAs inside the next 48 hours; the latest notice per ship decides', () => {
    const moved = [eta('a', 10, { at: at(5) }), eta('a', 60, { at: at(1), id: 'a:later' })];
    const counted = arrivalsDue([eta('b', 47.9), eta('c', 48.1), eta('d', -1), ...moved, eta('e', 5, { portId: 'singapore' })], 'rotterdam', now);
    expect(counted.map(notice => notice.shipmentId)).toEqual(['b']);
  });
});

describe('risk', () => {
  test('a quiet port is normal', () => {
    expect(assessPort(inputs())).toMatchObject({ risk: 'normal', anchored: 0, arrivals48h: 0, evidenceIds: [], reasons: [] });
  });

  test('count bands enter at the declared count and hold until the exit count', () => {
    const level = (previous: 0 | 1 | 2, value: number) => countLevel(bands.anchored, previous, value);
    expect([level(0, 1), level(0, 2), level(0, 4)]).toEqual([0, 1, 2]);
    expect([level(1, 1), level(0, 1), level(1, 0)]).toEqual([1, 0, 0]);
    expect([level(2, 3), level(2, 2), level(2, 1), level(2, 0)]).toEqual([2, 1, 1, 0]);
  });

  test('two ships queued make the port elevated; one more signal corroborates it into severe', () => {
    const queue = [observation('a'), observation('b')];
    expect(assessPort(inputs({ observations: queue })).risk).toBe('elevated');
    expect(assessPort(inputs({ observations: queue, notices: [hazard('moderate', 100)] })).risk).toBe('severe');
    expect(assessPort(inputs({ observations: queue, etas: [eta('c', 5), eta('d', 6), eta('e', 7)] })).risk).toBe('severe');
    expect(assessPort(inputs({ notices: [hazard('moderate', 100)] })).risk).toBe('elevated');
  });

  test('hysteresis: a queue that shrinks from two to one stays elevated, once, and clears at none', () => {
    const first = assessPort(inputs({ observations: [observation('a'), observation('b')] }));
    const shrunk = assessPort(inputs({ observations: [observation('a')], previous: { levels: first.levels, anchoredShips: first.anchoredShips } }));
    expect(shrunk.risk).toBe('elevated');
    expect(assessPort(inputs({ observations: [observation('a')] })).risk).toBe('normal');
    expect(assessPort(inputs({ previous: { levels: shrunk.levels, anchoredShips: shrunk.anchoredShips } })).risk).toBe('normal');
  });

  test('cites the evidence it counted', () => {
    const assessed = assessPort(inputs({ observations: [observation('a'), observation('b')], etas: [eta('c', 5)], notices: [hazard('severe', 50)] }));
    expect(assessed.evidenceIds).toEqual(['test:severe', 'a:obs:x', 'b:obs:x', 'c:eta:5']);
  });
});

describe('bulletins', () => {
  const queue = assessPort(inputs({ observations: [observation('a'), observation('b')] }));
  test('a quiet port that never spoke posts nothing', () => {
    expect(decideBulletin(assessPort(inputs()), null, 'Rotterdam', now)).toBeNull();
  });

  test('posts on a change in risk or counts, and is a valid board message', () => {
    const first = decideBulletin(queue, null, 'Rotterdam', now)!;
    expect(first).toMatchObject({ kind: 'port.bulletin', portId: 'rotterdam', risk: 'elevated', anchored: 2, arrivals48h: 0, id: 'bulletin:rotterdam#1' });
    expect(parseBoardMessage(first)).toEqual(first);
    expect(decideBulletin(queue, first, 'Rotterdam', now)).toBeNull();
    const withArrival = assessPort(inputs({ observations: [observation('a'), observation('b')], etas: [eta('c', 5)] }));
    expect(decideBulletin(withArrival, first, 'Rotterdam', now)).toMatchObject({ id: 'bulletin:rotterdam#2', arrivals48h: 1 });
  });

  test('a retry after a failed post carries the same id; a return to an earlier state is a new message', () => {
    const first = decideBulletin(queue, null, 'Rotterdam', now)!;
    const cleared = assessPort(inputs());
    const retryA = decideBulletin(cleared, first, 'Rotterdam', now)!;
    const retryB = decideBulletin(cleared, first, 'Rotterdam', new Date(now.getTime() + 60_000))!;
    expect(retryA.id).toBe(retryB.id);
    expect(retryA.id).toBe('bulletin:rotterdam#2');
    expect(decideBulletin(queue, retryA, 'Rotterdam', now)?.id).toBe('bulletin:rotterdam#3');
  });

  test('the summary names the reasons and fits the board limit', () => {
    const loud = assessPort(inputs({ notices: [hazard('extreme', 10)], observations: [observation('a'), observation('b')] }));
    const bulletin = decideBulletin(loud, null, 'Rotterdam', now)!;
    expect(bulletin.summary).toContain('severe');
    expect(bulletin.summary).toContain('2 ships stopped outside the port');
    expect(bulletin.summary.length).toBeLessThanOrEqual(280);
  });
});

describe('port status', () => {
  const fleet = demoShipments(now).filter(ship => ['gz-1042', 'gz-1043', 'gz-1044', 'gz-1045'].includes(ship.id));
  test('relevance counts the shipments whose remaining route includes the port, origin excluded', () => {
    expect(Object.fromEntries(ports.map(port => [port.id, relevance(fleet, port.id)]))).toEqual({ singapore: 2, rotterdam: 1, shanghai: 1, 'los-angeles': 1, 'jebel-ali': 0 });
  });

  test('the latest bulletin gives the risk; a silent port is normal', () => {
    const older: PortBulletin = decideBulletin(queueAssessment(), null, 'Rotterdam', new Date(now.getTime() - 3_600_000))!;
    const newer: PortBulletin = { ...older, id: 'bulletin:rotterdam#2', at: now.toISOString(), risk: 'normal', anchored: 0 };
    const statuses = portStatuses(ports, fleet, [newer, older]);
    expect(latestBulletin([older, newer], 'rotterdam')?.id).toBe('bulletin:rotterdam#2');
    expect(statuses.find(status => status.portId === 'rotterdam')).toMatchObject({ risk: 'normal', relevance: 1, bulletin: { id: 'bulletin:rotterdam#2' } });
    expect(portStatuses(ports, fleet, [older]).find(status => status.portId === 'rotterdam')?.risk).toBe('elevated');
    expect(statuses.find(status => status.portId === 'singapore')).toEqual({ portId: 'singapore', risk: 'normal', relevance: 2, bulletin: null });
  });
});

function queueAssessment() { return assessPort(inputs({ observations: [observation('a'), observation('b')] })); }
