import type { EtaNotice, PortBulletin, ShipAssessment, ShipObservation } from '../../src/core/board';
import { assessDisruption, demoShipments } from '../../src/core/demo';
import { ports } from '../../src/core/ports';
import type { Dashboard, Disruption, Evidence } from '../../src/core/types';

/** Synthetic, local-only UI evidence. No AIS, Relay, model or external provider was called. */
const fixtureAt = '2026-10-31T12:00:00.000Z';
export const fixtureEvidence: Evidence = {
  id: 'fixture:external-notice', source: 'simulation', title: 'Simulated Singapore disruption',
  detail: 'Synthetic citation fixture — not a live port report.', observedAt: fixtureAt,
};
/** Deliberately fabricated provider-shaped input for provenance rendering tests, not a source integration. */
export const liveEvidenceFixture: Evidence = {
  id: 'fixture:provider-shaped-evidence', source: 'live', provider: 'UI fixture — not a live provider',
  url: 'https://example.com/fixture-evidence', title: 'Fabricated external-source UI input',
  detail: 'Fabricated UI test input. No provider was queried; this is not a live report.', observedAt: fixtureAt,
};
const fixtureDisruption: Disruption = { id: 'fixture:disruption', portId: 'singapore', delayHours: 36, evidence: fixtureEvidence };
const fixtureShipments = demoShipments(new Date(fixtureAt)).map(shipment => assessDisruption(shipment, fixtureDisruption));
const fixtureSubject = fixtureShipments.find(shipment => shipment.id === 'gz-1042');
if (!fixtureSubject) throw new Error('Synthetic fixture subject missing');
export const fixtureObservation: ShipObservation = {
  id: 'fixture:observation', kind: 'ship.observation',
  author: { role: 'ship', id: 'gz-1042', vessel: 'Meridian Star' },
  at: fixtureAt, summary: 'Synthetic vessel reports waiting outside Singapore.',
  shipmentId: 'gz-1042', signals: ['stationary-outside-port'], position: [103.82, 1.26],
  nearPort: 'singapore', provider: 'Synthetic fixture — no AIS connection', observedAt: fixtureAt,
};
export const fixtureBulletin: PortBulletin = {
  id: 'fixture:bulletin', kind: 'port.bulletin', author: { role: 'port', id: 'singapore' },
  at: fixtureAt, summary: 'Synthetic Singapore bulletin cites a vessel report and scenario evidence.',
  portId: 'singapore', risk: 'elevated', anchored: 1, arrivals48h: 1,
  evidenceIds: [fixtureObservation.id, fixtureEvidence.id, 'fixture:missing-reference'],
};
export const fixtureAssessment: ShipAssessment = {
  id: 'fixture:assessment', kind: 'ship.assessment', author: fixtureObservation.author,
  at: fixtureAt, summary: 'Synthetic rule-based assessment revises the arrival estimate by 36 hours.',
  shipmentId: fixtureSubject.id, risk: fixtureSubject.risk, eta: fixtureSubject.eta,
  delayHours: { low: fixtureSubject.delayHours, likely: fixtureSubject.delayHours, high: fixtureSubject.delayHours },
  confidence: null, method: 'rule-based', citedEvidence: [fixtureBulletin.id],
  ports: [...fixtureSubject.via, fixtureSubject.destination],
};
export const fixtureEta: EtaNotice = {
  id: 'fixture:eta', kind: 'ship.eta', author: fixtureObservation.author,
  at: fixtureAt, summary: 'Synthetic destination ETA update cites the assessment that changed it.',
  shipmentId: fixtureSubject.id, portId: fixtureSubject.destination,
  eta: fixtureSubject.eta, previousEta: fixtureSubject.baselineEta, citedEvidence: [fixtureAssessment.id],
};
export const societyDashboard: Dashboard = {
  shipments: fixtureShipments,
  ports, updatedAt: fixtureAt, mode: 'simulation',
  runtime: 'TEST fixture — no durable runtime', relay: 'TEST fixture — no Relay connection',
  board: [fixtureObservation, fixtureBulletin, fixtureAssessment, fixtureEta],
  portStatus: [
    { portId: 'singapore', risk: 'elevated', relevance: 1, bulletin: fixtureBulletin },
    { portId: 'rotterdam', risk: 'severe', relevance: 2, bulletin: null },
    { portId: 'shanghai', risk: 'normal', relevance: 0, bulletin: null },
  ],
};
