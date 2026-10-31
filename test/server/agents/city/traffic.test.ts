import { describe, expect, test } from 'bun:test';
import { parseBoardMessage, type BoardMessage, type EtaNotice, type ShipObservation, type TrafficReport } from '../../../../src/core/board';
import { ports } from '../../../../src/core/ports';
import type { RelayOutcome } from '../../../../src/core/types';
import { anchoredShips, arrivalsDue, assessTraffic, bands, countLevel, decideTraffic, emptyTrafficMemory, watchTraffic, type BoardIo, type TrafficInputs } from '../../../../src/server/agents/city/traffic';
import type { RelayCursor } from '../../../../src/server/relay/board';
import type { RelayIdentity } from '../../../../src/server/relay/client';

const now = new Date('2026-10-31T20:00:00.000Z');
const rotterdam = ports.find(port => port.id === 'rotterdam')!;
const at = (hoursAgo: number): string => new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
const later = (hours: number): Date => new Date(now.getTime() + hours * 3_600_000);
const north = (km: number): [number, number] => [rotterdam.coordinates[0], rotterdam.coordinates[1] + km / 111.195];

const observation = (shipmentId: string, overrides: Partial<ShipObservation> = {}): ShipObservation => ({
  id: `${shipmentId}:obs:${overrides.observedAt ?? 'x'}`, kind: 'ship.observation', author: { role: 'ship', id: shipmentId, vessel: shipmentId },
  at: at(1), summary: 'stopped', shipmentId, signals: ['stationary-outside-port'], position: north(20), nearPort: 'rotterdam', provider: 'test', observedAt: at(2), ...overrides,
});
const eta = (shipmentId: string, hoursAhead: number, overrides: Partial<EtaNotice> = {}): EtaNotice => ({
  id: `${shipmentId}:eta:${hoursAhead}`, kind: 'ship.eta', author: { role: 'ship', id: shipmentId, vessel: shipmentId }, at: at(1), summary: 'eta',
  shipmentId, portId: 'rotterdam', eta: new Date(now.getTime() + hoursAhead * 3_600_000).toISOString(), previousEta: at(0), ...overrides,
});
const inputs = (overrides: Partial<TrafficInputs> = {}): TrafficInputs => ({
  city: 'rotterdam', coordinates: rotterdam.coordinates, now, observations: [], etas: [], previous: null, ...overrides,
});
const queue = () => assessTraffic(inputs({ observations: [observation('a'), observation('b')] }));

describe('anchored ships', () => {
  test('counts a ship whose latest observation is stationary near this city, and only that', () => {
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

describe('traffic risk', () => {
  test('a quiet city is normal', () => {
    expect(assessTraffic(inputs())).toMatchObject({ risk: 'normal', anchored: 0, arrivals48h: 0, evidenceIds: [] });
  });

  test('count bands enter at the declared count and hold until the exit count', () => {
    const level = (previous: 0 | 1 | 2, value: number) => countLevel(bands.anchored, previous, value);
    expect([level(0, 1), level(0, 2), level(0, 4)]).toEqual([0, 1, 2]);
    expect([level(1, 1), level(0, 1), level(1, 0)]).toEqual([1, 0, 0]);
    expect([level(2, 3), level(2, 2), level(2, 1), level(2, 0)]).toEqual([2, 1, 1, 0]);
  });

  test('two ships queued make traffic elevated; arrivals due as well corroborate it into severe', () => {
    expect(queue().risk).toBe('elevated');
    expect(assessTraffic(inputs({ observations: [observation('a'), observation('b')], etas: [eta('c', 5), eta('d', 6), eta('e', 7)] })).risk).toBe('severe');
    expect(assessTraffic(inputs({ etas: [eta('c', 5), eta('d', 6), eta('e', 7)] })).risk).toBe('elevated');
  });

  test('hysteresis: a queue that shrinks from two to one stays elevated, once, and clears at none', () => {
    const first = queue();
    const shrunk = assessTraffic(inputs({ observations: [observation('a')], previous: { levels: first.levels, anchoredShips: first.anchoredShips } }));
    expect(shrunk.risk).toBe('elevated');
    expect(assessTraffic(inputs({ observations: [observation('a')] })).risk).toBe('normal');
    expect(assessTraffic(inputs({ previous: { levels: shrunk.levels, anchoredShips: shrunk.anchoredShips } })).risk).toBe('normal');
  });

  test('cites the observations and ETAs it aggregated', () => {
    const assessed = assessTraffic(inputs({ observations: [observation('a'), observation('b')], etas: [eta('c', 5)] }));
    expect(assessed.evidenceIds).toEqual(['a:obs:x', 'b:obs:x', 'c:eta:5']);
  });
});

describe('traffic reports', () => {
  test('a quiet city that never spoke posts nothing', () => {
    expect(decideTraffic(assessTraffic(inputs()), null, now)).toBeNull();
  });

  test('posts on a change, signed by the city\'s traffic watch, with the city\'s declared service rate, as a valid board message', () => {
    const first = decideTraffic(queue(), null, now)!;
    expect(first).toMatchObject({ kind: 'city.traffic', author: { role: 'city', city: 'rotterdam', element: 'traffic' }, risk: 'elevated', anchored: 2, arrivals48h: 0, id: 'traffic:rotterdam#1', basis: rotterdam.serviceRate });
    expect(parseBoardMessage(first)).toEqual(first);
    expect(decideTraffic(queue(), first, now)).toBeNull();
    const withArrival = assessTraffic(inputs({ observations: [observation('a'), observation('b')], etas: [eta('c', 5)] }));
    expect(decideTraffic(withArrival, first, now)).toMatchObject({ id: 'traffic:rotterdam#2', arrivals48h: 1 });
  });

  test('the summary speaks as the watch and every number in it is a field of the message', () => {
    const report = decideTraffic(assessTraffic(inputs({ observations: [observation('a'), observation('b')], etas: [eta('c', 5)] })), null, now)!;
    expect(report.summary).toBe(`Rotterdam traffic watch: ${report.risk}, ${report.anchored} ships anchored outside, ${report.arrivals48h} arrival due within forty-eight hours.`);
  });

  test('re-said every 6 hours while not normal, and never while normal', () => {
    const first = decideTraffic(queue(), null, now)!;
    expect(decideTraffic(queue(), first, later(5.9))).toBeNull();
    expect(decideTraffic(queue(), first, later(6))).toMatchObject({ id: 'traffic:rotterdam#2', risk: 'elevated', anchored: 2 });
    const cleared = decideTraffic(assessTraffic(inputs()), first, now)!;
    expect(decideTraffic(assessTraffic(inputs()), cleared, later(48))).toBeNull();
  });

  test('a retry after a failed post carries the same id; a return to an earlier state is a new message', () => {
    const first = decideTraffic(queue(), null, now)!;
    const cleared = assessTraffic(inputs());
    const retryA = decideTraffic(cleared, first, now)!;
    const retryB = decideTraffic(cleared, first, new Date(now.getTime() + 60_000))!;
    expect(retryA.id).toBe(retryB.id);
    expect(retryA.id).toBe('traffic:rotterdam#2');
    expect(decideTraffic(queue(), retryA, now)?.id).toBe('traffic:rotterdam#3');
  });
});

describe('a traffic watch alarm', () => {
  const identity: RelayIdentity = { token: 't', channel: 'c' };
  const watch = { city: 'rotterdam' as const, coordinates: rotterdam.coordinates, now };
  const stopped = (shipmentId: string, signals: ShipObservation['signals'] = ['stationary-outside-port'], observedAt = '2026-10-31T18:00:00.000Z'): ShipObservation => ({
    id: `${shipmentId}:${observedAt}`, kind: 'ship.observation', author: { role: 'ship', id: shipmentId, vessel: shipmentId }, at: observedAt, summary: 'stopped',
    shipmentId, signals, position: [rotterdam.coordinates[0], rotterdam.coordinates[1] + 0.2], nearPort: 'rotterdam', provider: 'test', observedAt,
  });
  type Script = { reads: (RelayOutcome<{ messages: readonly BoardMessage[]; cursor: RelayCursor }>)[]; posts: (RelayOutcome<string>)[] };
  const fake = (script: Script) => {
    const posted: BoardMessage[] = [];
    const io: BoardIo = {
      read: async (_identity, cursor) => script.reads.shift() ?? { status: 'ok', value: { messages: [], cursor } },
      post: async (_identity, message) => { posted.push(message); return script.posts.shift() ?? { status: 'ok', value: `relay-${message.id}` }; },
    };
    return { io, posted };
  };
  const read = (messages: readonly BoardMessage[], messageId: string): RelayOutcome<{ messages: readonly BoardMessage[]; cursor: RelayCursor }> =>
    ({ status: 'ok', value: { messages, cursor: { messageId, createdAt: null } } });
  const report = (city: TrafficReport['author']['city'], id: string, at: string): TrafficReport => ({
    id, kind: 'city.traffic', author: { role: 'city', city, element: 'traffic' }, at, summary: 'quiet', risk: 'normal', anchored: 0, arrivals48h: 0, evidenceIds: [],
    basis: ports.find(port => port.id === city)!.serviceRate,
  });

  test('reads the ships\' observations, posts one report, and stays silent while nothing changes', async () => {
    const { io, posted } = fake({ reads: [read([stopped('a'), stopped('b')], 'm1')], posts: [] });
    const first = await watchTraffic(io, identity, emptyTrafficMemory, watch);
    expect(first.outcome).toEqual({ status: 'ok', value: null });
    expect(posted.map(message => message.id)).toEqual(['traffic:rotterdam#1']);
    expect(posted[0]).toMatchObject({ risk: 'elevated', anchored: 2 });
    expect(first.memory.cursor).toEqual({ messageId: 'm1', createdAt: null });
    const second = await watchTraffic(io, identity, first.memory, watch);
    expect(second.outcome.status).toBe('ok');
    expect(posted).toHaveLength(1);
  });

  test('a ship moving on is a change, and the next report says so', async () => {
    const { io, posted } = fake({ reads: [read([stopped('a'), stopped('b')], 'm1'), read([stopped('b', ['slow-steaming'], '2026-10-31T19:00:00.000Z')], 'm2')], posts: [] });
    const first = await watchTraffic(io, identity, emptyTrafficMemory, watch);
    const second = await watchTraffic(io, identity, first.memory, watch);
    expect(posted.map(message => message.id)).toEqual(['traffic:rotterdam#1', 'traffic:rotterdam#2']);
    expect(posted[1]).toMatchObject({ anchored: 1, risk: 'elevated' });
    expect(second.memory.report?.id).toBe('traffic:rotterdam#2');
  });

  test('an unreadable board changes nothing and posts nothing', async () => {
    const { io, posted } = fake({ reads: [{ status: 'unavailable', message: 'down' }], posts: [] });
    const result = await watchTraffic(io, identity, emptyTrafficMemory, watch);
    expect(result.outcome).toEqual({ status: 'unavailable', message: 'down' });
    expect(result.memory).toBe(emptyTrafficMemory);
    expect(posted).toEqual([]);
  });

  test('a failed post is reported, and the retry carries the same id', async () => {
    const { io, posted } = fake({ reads: [read([stopped('a'), stopped('b')], 'm1')], posts: [{ status: 'unavailable', message: 'relay down' }] });
    const failed = await watchTraffic(io, identity, emptyTrafficMemory, watch);
    expect(failed.outcome).toEqual({ status: 'unavailable', message: 'relay down' });
    expect(failed.memory.report).toBeNull();
    const retried = await watchTraffic(io, identity, failed.memory, watch);
    expect(retried.outcome.status).toBe('ok');
    expect(posted.map(message => message.id)).toEqual(['traffic:rotterdam#1', 'traffic:rotterdam#1']);
  });

  test('a restarted watch with empty memory resumes the sequence from its own earlier report on the board', async () => {
    const { io, posted } = fake({ reads: [read([report('rotterdam', 'traffic:rotterdam#3', '2026-10-31T10:00:00.000Z'), stopped('a'), stopped('b')], 'm9')], posts: [] });
    await watchTraffic(io, identity, emptyTrafficMemory, watch);
    expect(posted[0]?.id).toBe('traffic:rotterdam#4');
  });

  test('another city\'s report is not this city\'s', async () => {
    const { io, posted } = fake({ reads: [read([{ ...report('singapore', 'traffic:singapore#7', now.toISOString()), risk: 'severe', anchored: 9 }], 'm1')], posts: [] });
    const result = await watchTraffic(io, identity, emptyTrafficMemory, watch);
    expect(result.memory.report).toBeNull();
    expect(posted).toEqual([]);
  });
});
