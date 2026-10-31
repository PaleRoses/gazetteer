import { describe, expect, test } from 'bun:test';
import digitraffic from './fixtures/telemetry/digitraffic-locations.json';
import { defaultThresholds, nextSituation, observe, parseLocations, type KnownPort, type LonLat, type Plan, type Signal, type Telemetry } from '../src/server/telemetry';

const fetchedAt = '2026-10-31T19:45:00.000Z';
const real = (mmsi: string): Telemetry => {
  const outcome = parseLocations(digitraffic, mmsi, fetchedAt);
  if (outcome.status !== 'ok') throw new Error(`fixture lacks ${mmsi}`);
  return outcome.value;
};
const testPorts: readonly KnownPort[] = [
  { name: 'Helsinki', coordinates: [24.95, 60.17] }, { name: 'Kotka', coordinates: [26.95, 60.47] }, { name: 'Vaasa', coordinates: [21.6, 63.1] },
];
const at = (telemetry: Telemetry, seconds = 20): string => new Date(Date.parse(telemetry.observedAt) + seconds * 1000).toISOString();

/** A straight plan through the vessel along its own course: `behindKm` astern, `aheadKm` ahead, optionally slid sideways. The plan is a test construction; the telemetry is real. */
const planThrough = (telemetry: Telemetry, aheadKm: number, sideKm = 0, behindKm = 100): readonly [LonLat, LonLat] => {
  const [lon, lat] = telemetry.position;
  const bearing = (telemetry.cogDegrees ?? 0) * Math.PI / 180;
  const offset = (km: number, direction: number): LonLat => [
    lon + Math.sin(direction) * km / (111.2 * Math.cos(lat * Math.PI / 180)), lat + Math.cos(direction) * km / 111.2,
  ];
  const side = bearing + Math.PI / 2;
  const slide = (point: LonLat): LonLat => [point[0] + Math.sin(side) * sideKm / (111.2 * Math.cos(lat * Math.PI / 180)), point[1] + Math.cos(side) * sideKm / 111.2];
  return [slide(offset(behindKm, bearing + Math.PI)), slide(offset(aheadKm, bearing))];
};
const etaIn = (telemetry: Telemetry, hours: number): string => new Date(Date.parse(at(telemetry)) + hours * 3_600_000).toISOString();
const kinds = (signals: readonly Signal[]): readonly string[] => signals.map(signal => signal.kind);

describe('watcher on real Digitraffic telemetry', () => {
  const underway = real('273251360');
  const aheadKm = 600;
  const needed = (knots: number): number => aheadKm / 1.852 / knots;

  test('a vessel making the speed its ETA implies raises nothing', () => {
    const plan: Plan = { route: planThrough(underway, aheadKm), eta: etaIn(underway, needed(underway.sogKnots!)), ports: testPorts };
    expect(observe(plan, underway, at(underway)).signals).toEqual([]);
  });

  test('steaming well below the implied speed is slow steaming, with measured values and declared thresholds', () => {
    const plan: Plan = { route: planThrough(underway, aheadKm), eta: etaIn(underway, needed(underway.sogKnots! * 2.2)), ports: testPorts };
    const [signal, ...rest] = observe(plan, underway, at(underway)).signals;
    expect(rest).toEqual([]);
    expect(signal).toMatchObject({ kind: 'slow-steaming', provenance: 'live', provider: 'digitraffic', fetchedAt, thresholds: { slowRatio: 0.6 }, measured: { sogKnots: 13 } });
    expect(signal!.measured.impliedKnots as number).toBeGreaterThan(26);
    expect(signal!.telemetry).toEqual(underway);
  });

  test('the same vessel on a plan sliding away from it is off-route, and only that', () => {
    const plan: Plan = { route: planThrough(underway, aheadKm, 150), eta: etaIn(underway, needed(underway.sogKnots!)), ports: testPorts };
    const observation = observe(plan, underway, at(underway));
    expect(kinds(observation.signals)).toEqual(['off-route']);
    expect(observation.reading.offRouteKm).toBeGreaterThan(140);
    expect(observation.reading.offRouteKm).toBeLessThan(160);
    const near: Plan = { ...plan, route: planThrough(underway, aheadKm, 30) };
    expect(observe(near, underway, at(underway)).signals).toEqual([]);
  });

  test('a vessel at anchor away from any port is a congestion tell; a moored one beside its port is not', () => {
    const anchored = real('538010578');
    const farPlan: Plan = { route: planThrough(anchored, 400), eta: etaIn(anchored, 30), ports: testPorts };
    const [signal] = observe(farPlan, anchored, at(anchored)).signals;
    expect(signal).toMatchObject({ kind: 'stationary-outside-port', measured: { navStatus: 'at anchor' }, thresholds: { berthRadiusKm: 5 } });
    expect(signal!.measured.nearestPortKm as number).toBeGreaterThan(5);
    const moored = real('230098780');
    expect(observe({ route: planThrough(moored, 100), eta: etaIn(moored, 5), ports: testPorts }, moored, at(moored)).signals).toEqual([]);
  });

  test('a silent transponder is dark, and its stale position yields no other signal', () => {
    const plan: Plan = { route: planThrough(underway, aheadKm, 300), eta: etaIn(underway, 3), ports: testPorts };
    const later = new Date(Date.parse(underway.observedAt) + 3 * 3_600_000).toISOString();
    const observation = observe(plan, underway, later);
    expect(kinds(observation.signals)).toEqual(['ais-dark']);
    expect(observation.signals[0]!.measured.ageMinutes).toBeCloseTo(180, 0);
    expect(kinds(observe(plan, underway, at(underway)).signals)).not.toContain('ais-dark');
  });

  test('thresholds are parameters: the same reading flips at the declared boundary', () => {
    const plan: Plan = { route: planThrough(underway, aheadKm, 60), eta: etaIn(underway, needed(underway.sogKnots!)), ports: testPorts };
    expect(kinds(observe(plan, underway, at(underway)).signals)).toEqual(['off-route']);
    expect(observe(plan, underway, at(underway), { ...defaultThresholds, offRouteKm: 80 }).signals).toEqual([]);
  });
});

describe('situations', () => {
  const signal = (kind: Signal['kind']): Signal => ({ id: kind, kind, title: '', detail: '', observedAt: '', provenance: 'live', provider: 'digitraffic', fetchedAt, measured: {}, thresholds: {}, telemetry: real('273251360') });
  test('no signals, no situation; a new kind opens one; persistence and shrinking keep the same id', () => {
    expect(nextSituation(null, [], 'gz-1', 't1')).toBeNull();
    const first = nextSituation(null, [signal('off-route')], 'gz-1', 't1')!;
    expect(first.id).toBe('telemetry:gz-1:off-route:t1');
    expect(nextSituation(first, [signal('off-route')], 'gz-1', 't2')).toBe(first);
    const wider = nextSituation(first, [signal('off-route'), signal('slow-steaming')], 'gz-1', 't3')!;
    expect(wider.id).not.toBe(first.id);
    expect(nextSituation(wider, [signal('slow-steaming')], 'gz-1', 't4')).toBe(wider);
    expect(nextSituation(wider, [], 'gz-1', 't5')).toBeNull();
    expect(nextSituation(null, [signal('off-route')], 'gz-1', 't6')!.id).not.toBe(first.id);
  });
});
