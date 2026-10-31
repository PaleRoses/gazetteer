import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBoardMessage } from '../../../../src/core/board';
import { assessHazards, decideHazards, noticeLevel } from '../../../../src/server/agents/city/hazards';
import type { PortHit } from '../../../../src/server/sources/exposure';
import type { Notice, NoticeSeverity } from '../../../../src/server/sources/notice';
import { normalizeNws } from '../../../../src/server/sources/nws';
import { noticesForPort, type PortNotice } from '../../../../src/server/sources/poll';

const now = new Date('2026-10-31T20:00:00.000Z');
const later = (hours: number): Date => new Date(now.getTime() + hours * 3_600_000);
const notice = (severity: NoticeSeverity, id = `test:${severity}`): Notice => ({
  id, provider: 'gdacs', kind: 'cyclone', severity, title: `A ${severity} cyclone`, detail: '', observedAt: now.toISOString(), expiresAt: null,
  geometry: { kind: 'point', coordinates: [0, 0] }, url: 'https://www.gdacs.org/report.aspx?eventid=1', fetchedAt: '2026-10-31T19:59:00.000Z', provenance: 'live',
});
const hazard = (severity: NoticeSeverity, distanceKm: number, basis: PortHit['basis'] = 'distance', id?: string): PortNotice => ({
  notice: notice(severity, id), hit: { portId: 'rotterdam', distanceKm, radiusKm: 600, basis }, lanes: [],
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

  test('the recorded Los Angeles marine statement is minor: listed, but the city stays normal', () => {
    const fixture = JSON.parse(readFileSync(resolve(import.meta.dir, '../../../fixtures/sources/nws-alerts-la.json'), 'utf8')) as unknown;
    const reaching = noticesForPort(normalizeNws(fixture, now.toISOString()), 'los-angeles', now);
    expect(reaching).toHaveLength(1);
    const assessed = assessHazards('los-angeles', reaching);
    expect(assessed).toMatchObject({ risk: 'normal', evidenceIds: [] });
    expect(assessed.notices.map(item => item.provider)).toEqual(['nws']);
  });

  test('the worst notice sets the risk and is the evidence', () => {
    const assessed = assessHazards('rotterdam', [hazard('moderate', 100, 'distance', 'a'), hazard('severe', 50, 'distance', 'b')]);
    expect(assessed.risk).toBe('severe');
    expect(assessed.evidenceIds).toEqual(['b']);
    expect(assessed.notices.map(item => item.id)).toEqual(['a', 'b']);
  });
});

describe('hazard reports', () => {
  test('a city with nothing in force that never spoke posts nothing', () => {
    expect(decideHazards(assessHazards('rotterdam', []), null, now)).toBeNull();
  });

  test('posts signed by the city\'s hazard watch, each notice with its provider, link and fetch time, as a valid board message', () => {
    const report = decideHazards(assessHazards('rotterdam', [hazard('severe', 50)]), null, now)!;
    expect(report).toMatchObject({
      id: 'hazards:rotterdam#1', kind: 'city.hazards', author: { role: 'city', city: 'rotterdam', element: 'hazards' }, risk: 'severe', evidenceIds: ['test:severe'],
      notices: [{ id: 'test:severe', provider: 'gdacs', url: 'https://www.gdacs.org/report.aspx?eventid=1', fetchedAt: '2026-10-31T19:59:00.000Z' }],
    });
    expect(parseBoardMessage(report)).toEqual(report);
    expect(report.summary).toBe(`Rotterdam hazard watch: ${report.risk}, ${report.notices.length} live notice in force: severe cyclone, A severe cyclone.`);
  });

  test('a change in the notices in force is a new report; the same notices are not', () => {
    const first = decideHazards(assessHazards('rotterdam', [hazard('moderate', 100, 'distance', 'a')]), null, now)!;
    expect(decideHazards(assessHazards('rotterdam', [hazard('moderate', 100, 'distance', 'a')]), first, now)).toBeNull();
    expect(decideHazards(assessHazards('rotterdam', [hazard('moderate', 100, 'distance', 'c')]), first, now)).toMatchObject({ id: 'hazards:rotterdam#2', risk: 'elevated' });
    expect(decideHazards(assessHazards('rotterdam', []), first, now)).toMatchObject({ id: 'hazards:rotterdam#2', risk: 'normal', notices: [] });
  });

  test('re-said every 6 hours while not normal, and never while normal', () => {
    const loud = assessHazards('rotterdam', [hazard('severe', 50)]);
    const first = decideHazards(loud, null, now)!;
    expect(decideHazards(loud, first, later(5.9))).toBeNull();
    expect(decideHazards(loud, first, later(6))?.id).toBe('hazards:rotterdam#2');
    const quiet = assessHazards('rotterdam', [hazard('minor', 50)]);
    const calm = decideHazards(quiet, null, now)!;
    expect(decideHazards(quiet, calm, later(48))).toBeNull();
  });
});
