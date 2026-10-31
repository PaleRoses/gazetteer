import { expect, test } from 'bun:test';
import { demoShipments } from '../../../../src/core/demo';
import type { Disruption, Shipment } from '../../../../src/core/types';
import { think } from '../../../../src/server/agents/ship/think';

test('replacing a voyage plan excludes earlier simulation exercises but assesses new ones', async () => {
  const now = '2026-10-31T12:00:00.000Z';
  const seed = demoShipments(new Date(now)).find(s => s.id === 'gz-1044')!;
  const shipment: Shipment = { ...seed, voyage: { source: 'operator', status: 'underway', departure: seed.milestones[0]!.at, eta: seed.eta, updatedBy: 'Operator', updatedAt: now, statusSince: now } };
  const disruption = (id: string, at: string): Disruption => ({ id, portId: 'singapore', delayHours: 12, evidence: { id, title: 'Demo congestion', detail: 'Test scenario', observedAt: at, source: 'simulation' } });
  const read = { cursor: null, board: [], disruptions: [disruption('old', '2026-10-31T10:00:00.000Z'), disruption('new', '2026-10-31T12:01:00.000Z')] };
  const deps = { binding: () => null, assess: { model: null, modelId: 'test', now: () => now } };
  const result = await think(deps, { shipment }, read, now);
  expect(result.state.shipment.delayHours).toBe(12);
  expect(result.state.shipment.appliedDisruptions).toEqual(['new']);
  const seeded = await think(deps, { shipment: seed }, read, now);
  expect(seeded.state.shipment.delayHours).toBe(24);
});
