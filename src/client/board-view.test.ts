import { describe, expect, test } from 'bun:test';
import type { BoardMessage, EtaNotice } from '../board';
import { ports } from '../domain';
import { boardExplanation, filterBoard, readableBoardSummary } from './board-view';

const arrival: EtaNotice = { id: 'eta-1', kind: 'ship.eta', author: { role: 'ship', id: 'ship-1', vessel: 'Meridian Star' }, at: '2026-10-31T12:00:00Z', summary: 'Meridian Star expects singapore at 2026-11-03T12:00Z.', shipmentId: 'ship-1', portId: 'singapore', eta: '2026-11-03T12:00:00Z', previousEta: '2026-11-02T00:00:00Z' };
const bulletin: BoardMessage = { id: 'port-1', kind: 'port.bulletin', author: { role: 'port', id: 'singapore' }, at: '2026-10-31T13:00:00Z', summary: 'Singapore is busy.', portId: 'singapore', risk: 'elevated', anchored: 3, arrivals48h: 8, evidenceIds: [] };

describe('human-readable agent activity', () => {
  test('arrival changes distinguish later, earlier and unchanged', () => {
    expect(boardExplanation(arrival, ports)).toContain('36 hours later');
    expect(boardExplanation({ ...arrival, eta: arrival.previousEta, previousEta: arrival.eta }, ports)).toContain('36 hours earlier');
    expect(boardExplanation({ ...arrival, previousEta: arrival.eta }, ports)).toContain('unchanged');
  });
  test('port scope includes ships reporting to that port without including unrelated ports', () => {
    expect(filterBoard([arrival, bulletin], 'all', 'port:singapore', '', ports).map(m => m.id)).toEqual(['port-1', 'eta-1']);
    expect(filterBoard([arrival, bulletin], 'all', 'port:rotterdam', '', ports)).toEqual([]);
    expect(filterBoard([arrival, bulletin], 'all', 'ship:ship-1', '', ports)).toEqual([arrival]);
  });
  test('kind and human-readable search combine and do not reorder the source', () => {
    const source = [arrival, bulletin];
    expect(filterBoard(source, 'ship.eta', 'all', '  SINGAPORE ', ports)).toEqual([arrival]);
    expect(filterBoard(source, 'all', 'all', 'meridian', ports)).toEqual([arrival]);
    expect(filterBoard(source, 'all', 'all', 'nothing matches', ports)).toEqual([]);
    expect(source[0]).toBe(arrival);
  });
  test('assessment explanations keep the reason and omit implementation setup text', () => {
    const assessment: BoardMessage = { id: 'assessment-1', kind: 'ship.assessment', author: arrival.author, at: arrival.at, shipmentId: arrival.shipmentId, risk: 'delayed', eta: arrival.eta, delayHours: { low: 36, likely: 36, high: 36 }, confidence: 0, method: 'deterministic-fallback', citedEvidence: [], ports: ['singapore'], summary: 'GZ-1042 Meridian Star: delayed, ETA 2026-11-03T12:00Z (+36h). Deterministic fallback (no model API key configured): Singapore disruption adds 36h to the arrival estimate.' };
    expect(readableBoardSummary(assessment, ports)).toBe('Rule-based estimate: Singapore disruption adds 36h to the arrival estimate.');
    expect(boardExplanation(assessment, ports)).toContain('Estimated delay: 36 hours.');
    expect(boardExplanation(assessment, ports)).not.toContain('36–36');
  });
  test('summaries retain agent reasoning but use readable names and times', () => {
    const text = readableBoardSummary(arrival, ports);
    expect(text).toContain('Singapore');
    expect(text).toContain('UTC');
    expect(text).not.toContain('T12:00Z');
  });
});
