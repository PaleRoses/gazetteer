import { describe, expect, test } from 'bun:test';
import type { BoardMessage } from '../../../../src/core/board';
import { assessHazards, decideHazards } from '../../../../src/server/agents/city/hazards';
import type { PortNotice } from '../../../../src/server/sources/poll';
import { runSociety } from '../../../society-run';

const numbers = (text: string): readonly string[] => text.match(/\d+(?:\.\d+)?/g) ?? [];
/** A number in a watch's summary must be one the message carries in another field; constants appear as words. */
const unexplained = (message: BoardMessage): readonly string[] => {
  const { summary, ...rest } = message;
  const known = new Set(numbers(JSON.stringify(rest)));
  return numbers(summary).filter(token => !known.has(token));
};
const now = new Date('2026-10-31T20:00:00.000Z');
const reaching = (id: string, severity: 'minor' | 'severe', title: string): PortNotice => ({
  notice: { id, provider: 'usgs', kind: 'earthquake', severity, title, detail: '', observedAt: now.toISOString(), expiresAt: null, geometry: { kind: 'point', coordinates: [0, 0] }, url: 'https://earthquake.usgs.gov/', fetchedAt: now.toISOString(), provenance: 'live' },
  hit: { portId: 'singapore', distanceKm: 10, radiusKm: 600, basis: 'distance' }, lanes: [],
});

describe('city watch voice', () => {
  test('every number in a traffic report\'s summary is one of its own fields', async () => {
    const { board } = await runSociety();
    const reports = board.filter(message => message.kind === 'city.traffic');
    expect(reports.length).toBeGreaterThan(0);
    reports.forEach(report => expect(unexplained(report)).toEqual([]));
  });

  test('every number in a hazard report\'s summary is one of its own fields, whatever is in force', () => {
    const cases = [[], [reaching('a', 'minor', 'M 4.6 - 80 km SW of a town')], [reaching('a', 'minor', 'M 4.6'), reaching('b', 'severe', 'M 7.1 - 12 km N of the port'), reaching('c', 'minor', 'M 5.0')]];
    const reports = cases.map(notices => decideHazards(assessHazards('singapore', notices), { ...decideHazards(assessHazards('singapore', [reaching('z', 'severe', 'x')]), null, now)!, risk: 'elevated' }, now)!);
    reports.forEach(report => expect(unexplained(report)).toEqual([]));
  });

  test('the check can fail: a count the message does not carry is caught', () => {
    const report = decideHazards(assessHazards('singapore', [reaching('a', 'minor', 'x'), reaching('b', 'minor', 'y'), reaching('c', 'minor', 'w')]), null, now)!;
    expect(unexplained({ ...report, summary: `${report.notices.length} live notices in force` })).toEqual(['3']);
  });
});
