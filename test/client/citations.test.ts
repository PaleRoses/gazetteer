import { describe, expect, test } from 'bun:test';
import { resolveBoardCitations } from '../../src/client/citations';
import type { PortBulletin } from '../../src/core/board';
import { fixtureAssessment, fixtureBulletin, fixtureEta, fixtureEvidence, fixtureObservation, liveEvidenceFixture, societyDashboard } from './society-fixture';

describe('board citation resolution', () => {
  test('distinguishes authored messages, simulation evidence and unresolved references in citation order', () => {
    expect(resolveBoardCitations(fixtureBulletin, societyDashboard)).toEqual([
      { kind: 'message', id: fixtureObservation.id, message: fixtureObservation },
      { kind: 'evidence', id: fixtureEvidence.id, evidence: fixtureEvidence },
      { kind: 'unresolved', id: 'fixture:missing-reference' },
    ]);
    expect(resolveBoardCitations(fixtureObservation, societyDashboard)).toEqual([]);
  });

  test('does not infer a missing author or normalize citation IDs into a different reference', () => {
    const citedIds = [fixtureObservation.id.toUpperCase(), ` ${fixtureEvidence.id}`, 'ship:unknown-but-plausible'];
    const bulletin: PortBulletin = { ...fixtureBulletin, evidenceIds: citedIds };
    expect(resolveBoardCitations(bulletin, societyDashboard)).toEqual(citedIds.map(id => ({ kind: 'unresolved', id })));
  });

  test('assessment and ETA citations resolve their immediate authored source without flattening the chain', () => {
    expect(resolveBoardCitations(fixtureAssessment, societyDashboard)).toEqual([
      { kind: 'message', id: fixtureBulletin.id, message: fixtureBulletin },
    ]);
    expect(resolveBoardCitations(fixtureEta, societyDashboard)).toEqual([
      { kind: 'message', id: fixtureAssessment.id, message: fixtureAssessment },
    ]);
    const bulletin: PortBulletin = { ...fixtureBulletin, evidenceIds: [fixtureEta.id] };
    expect(resolveBoardCitations(bulletin, societyDashboard)).toEqual([
      { kind: 'message', id: fixtureEta.id, message: fixtureEta },
    ]);
  });

  test('missing feed history remains unresolved even when the referenced actor still exists', () => {
    expect(resolveBoardCitations(fixtureBulletin, { ...societyDashboard, board: [] })).toEqual([
      { kind: 'unresolved', id: fixtureObservation.id },
      { kind: 'evidence', id: fixtureEvidence.id, evidence: fixtureEvidence },
      { kind: 'unresolved', id: 'fixture:missing-reference' },
    ]);
  });

  test('resolves the exact bulletin retained in port status outside the board window', () => {
    const bulletin: PortBulletin = { ...fixtureBulletin, id: 'fixture:following-bulletin', evidenceIds: [fixtureBulletin.id] };
    expect(resolveBoardCitations(bulletin, { ...societyDashboard, board: [] })).toEqual([
      { kind: 'message', id: fixtureBulletin.id, message: fixtureBulletin },
    ]);
    expect(resolveBoardCitations(bulletin, { ...societyDashboard, board: [], portStatus: [] })).toEqual([
      { kind: 'unresolved', id: fixtureBulletin.id },
    ]);
  });

  test('preserves provider provenance only when the exact external evidence exists', () => {
    const dashboard = { ...societyDashboard, shipments: societyDashboard.shipments.map(shipment => ({ ...shipment, evidence: [liveEvidenceFixture] })) };
    const bulletin: PortBulletin = { ...fixtureBulletin, evidenceIds: [liveEvidenceFixture.id] };
    expect(resolveBoardCitations(bulletin, dashboard)).toEqual([
      { kind: 'evidence', id: liveEvidenceFixture.id, evidence: liveEvidenceFixture },
    ]);
    expect(resolveBoardCitations(bulletin, societyDashboard)).toEqual([
      { kind: 'unresolved', id: liveEvidenceFixture.id },
    ]);
  });
});
