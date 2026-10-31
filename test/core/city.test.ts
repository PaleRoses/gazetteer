import { describe, expect, test } from 'bun:test';
import type { HazardReport, TrafficReport } from '../../src/core/board';
import { cityStatuses, latestReport, relevance } from '../../src/core/city';
import { demoShipments } from '../../src/core/demo';
import { ports } from '../../src/core/ports';

const now = new Date('2026-10-31T20:00:00.000Z');
const fleet = demoShipments(now).filter(ship => ['gz-1042', 'gz-1043', 'gz-1044', 'gz-1045'].includes(ship.id));
const traffic = (id: string, at: string, risk: TrafficReport['risk'], city: TrafficReport['author']['city'] = 'rotterdam'): TrafficReport => ({
  id, kind: 'city.traffic', author: { role: 'city', city, element: 'traffic' }, at, summary: id, risk, anchored: 0, arrivals48h: 0, evidenceIds: [],
  basis: ports.find(port => port.id === city)!.serviceRate,
});
const hazards = (id: string, at: string, risk: HazardReport['risk']): HazardReport => ({
  id, kind: 'city.hazards', author: { role: 'city', city: 'rotterdam', element: 'hazards' }, at, summary: id, risk, notices: [], evidenceIds: [],
});

describe('cities', () => {
  test('relevance counts the shipments whose remaining route includes the city, origin excluded', () => {
    expect(relevance(fleet, 'singapore')).toBe(2);
    expect(relevance(fleet, 'rotterdam')).toBe(1);
    expect(relevance(fleet, 'busan')).toBe(0);
  });

  test('a city\'s risk is the worst of its agents\' latest reports, and each agent shows its own', () => {
    const board = [traffic('traffic:rotterdam#1', '2026-10-31T18:00:00.000Z', 'severe'), traffic('traffic:rotterdam#2', '2026-10-31T19:00:00.000Z', 'normal'), hazards('hazards:rotterdam#1', '2026-10-31T19:30:00.000Z', 'elevated')];
    const rotterdam = cityStatuses(ports, fleet, board).find(status => status.portId === 'rotterdam');
    expect(rotterdam).toMatchObject({
      risk: 'elevated', relevance: 1,
      agents: [{ element: 'traffic', risk: 'normal', latest: 'traffic:rotterdam#2' }, { element: 'hazards', risk: 'elevated', latest: 'hazards:rotterdam#1' }],
    });
    expect(latestReport(board, 'rotterdam', 'traffic')?.id).toBe('traffic:rotterdam#2');
  });

  test('another city\'s report is not this city\'s; a silent city is normal, and a city with no calls has no agents', () => {
    const statuses = cityStatuses(ports, fleet, [traffic('traffic:singapore#1', now.toISOString(), 'severe', 'singapore')]);
    expect(statuses.find(status => status.portId === 'rotterdam')).toMatchObject({ risk: 'normal', agents: [{ element: 'traffic', latest: null }, { element: 'hazards', latest: null }] });
    expect(statuses.find(status => status.portId === 'singapore')?.risk).toBe('severe');
    expect(statuses.find(status => status.portId === 'busan')).toMatchObject({ risk: 'normal', relevance: 0, agents: [] });
  });
});
