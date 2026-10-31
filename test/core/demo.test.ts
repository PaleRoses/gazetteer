import { describe, expect, test } from 'bun:test';
import { assessDisruption, demoShipments } from '../../src/core/demo';
import type { Disruption } from '../../src/core/types';

const at = '2026-10-31T12:00:00.000Z';
const disruption: Disruption = { id: 'd-1', portId: 'singapore', delayHours: 36,
  evidence: { id: 'd-1', source: 'simulation', title: 'Berth closure', detail: 'Synthetic 36-hour berth closure.', observedAt: at } };

describe('synthetic shipment impact', () => {
  test('upcoming Singapore calls change, unaffected voyages do not', () => {
    const shipments = demoShipments(new Date(at));
    const updated = shipments.map(shipment => assessDisruption(shipment, disruption));
    const calling = shipments.filter(shipment => shipment.destination === 'singapore' || shipment.via.includes('singapore')).map(shipment => shipment.id);
    expect(updated.filter(shipment => shipment.risk === 'delayed').map(shipment => shipment.id)).toEqual(calling);
    expect(calling).toEqual(expect.arrayContaining(['gz-1042', 'gz-1044']));
    expect(updated.filter(shipment => shipment.risk === 'on-track')).toEqual(shipments.filter(shipment => !calling.includes(shipment.id)));
    expect(updated.filter(shipment => ['gz-1043', 'gz-1045'].includes(shipment.id)).every(shipment => shipment.risk === 'on-track')).toBe(true);
    expect(updated.every(shipment => shipment.delayHours === 0 || Date.parse(shipment.eta) - Date.parse(shipment.baselineEta) === 36 * 3_600_000)).toBe(true);
  });
  test('redelivery cannot compound the ETA and retains supporting evidence', () => {
    const shipment = demoShipments(new Date(at))[0]!;
    const updated = assessDisruption(shipment, disruption);
    expect(assessDisruption(updated, disruption)).toBe(updated);
    expect(updated.evidence).toEqual([disruption.evidence]);
    expect(updated.milestones[0]).toEqual(shipment.milestones[0]);
    expect(updated.action).not.toBeNull();
  });
  test('a small delay is a watch and distinct events accumulate exactly once', () => {
    const shipment = demoShipments(new Date(at))[0]!;
    const first = assessDisruption(shipment, { ...disruption, delayHours: 6 });
    expect(first.risk).toBe('watch');
    const second = assessDisruption(first, { ...disruption, id: 'd-2', delayHours: 12 });
    expect(second.delayHours).toBe(18);
    expect(Date.parse(second.eta) - Date.parse(second.baselineEta)).toBe(18 * 3_600_000);
  });
});
