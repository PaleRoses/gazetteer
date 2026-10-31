import { describe, expect, test } from 'bun:test';
import { citations, concerns, parseBoardMessage } from '../../src/core/board';

const at = '2026-10-31T12:00:00.000Z';
const ship = { role: 'ship', id: 'gz-1042', vessel: 'Meridian Star' } as const;
const assessment = { id: 'asm:1', kind: 'ship.assessment', author: ship, at, summary: 's', shipmentId: 'gz-1042', risk: 'watch', eta: at, delayHours: null, ports: [] };

describe('the board protocol', () => {
  test('confidence is null exactly when the assessment is rule-based, and never zero in its place', () => {
    expect(parseBoardMessage({ ...assessment, method: 'rule-based', confidence: null, citedEvidence: [] })).toBeDefined();
    expect(parseBoardMessage({ ...assessment, method: 'rule-based', confidence: 0, citedEvidence: [] })).toBeUndefined();
    expect(parseBoardMessage({ ...assessment, method: 'ai-assessed', confidence: null, citedEvidence: [] })).toBeUndefined();
    expect(parseBoardMessage({ ...assessment, method: 'ai-assessed', confidence: 0.6, citedEvidence: [] })).toBeDefined();
  });

  test('a recovery message parses, cites what it answers, and belongs to the city it speaks to', () => {
    const request = parseBoardMessage({ id: 'r1', kind: 'recovery.request', author: { role: 'cargo', id: 'cargo-1', vessel: 'Meridian Star' }, at, summary: 's', caseId: 'case-1', answers: ['asm:1'], to: { role: 'city', city: 'rotterdam', element: 'terminal' }, service: 'unload' });
    expect(request).toBeDefined();
    expect(citations(request!)).toEqual(['asm:1']);
    expect(concerns(request!).ports).toEqual(['rotterdam']);
    expect(parseBoardMessage({ id: 'r2', kind: 'recovery.release', author: { role: 'haulier', city: 'rotterdam' }, at, summary: 's', caseId: 'case-1', answers: [], offerId: 'o1', key: 'case-1:o1' })).toBeDefined();
    expect(parseBoardMessage({ id: 'r3', kind: 'recovery.release', author: { role: 'ship', id: 'x', vessel: 'v' }, at, summary: 's', caseId: 'case-1', answers: [], offerId: 'o1', key: 'k' })).toBeUndefined();
  });
});
