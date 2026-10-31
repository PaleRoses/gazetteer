import { expect, test } from 'bun:test';
import { demoShipments } from '../../src/core/demo';
import { incomingShips, arrivalStatus } from '../../src/client/port-arrivals';
import type { Shipment } from '../../src/core/types';

const base = { ...demoShipments(new Date('2026-10-31T12:00:00Z'))[0]!, destination: 'singapore' as const, via: [] };
const voyage = (status: 'planned' | 'underway' | 'stopped' | 'arrived') => ({ departure: '2026-10-30T12:00:00Z', eta: base.eta, status, updatedAt: '2026-10-31T12:00:00Z', updatedBy: 'operator', statusSince: '2026-10-31T12:00:00Z', source: 'operator' as const });

test('incoming excludes origin-only ships and confirmed arrivals, retaining overdue unconfirmed arrivals', () => {
  const overdue = { ...base, id: 'overdue', eta: '2026-10-30T12:00:00Z' };
  const ships: Shipment[] = [base, overdue,
    { ...base, id: 'departed', origin: 'singapore', destination: 'rotterdam' },
    { ...base, id: 'arrived', voyage: voyage('arrived') },
    { ...base, id: 'complete', milestones: [{ label: 'Discharge at destination', at: base.eta, status: 'complete' }] },
  ];
  expect(incomingShips(ships, 'singapore').map(a => a.ship.id)).toEqual(['overdue', base.id]);
});

test('a transit call uses its own ETA and disappears once complete', () => {
  const transit: Shipment = { ...base, destination: 'rotterdam', via: ['singapore'], milestones: [{ label: 'Transshipment berth', at: '2026-11-01T12:00:00Z', status: 'upcoming' }] };
  expect(incomingShips([transit], 'singapore')[0]).toMatchObject({ eta: '2026-11-01T12:00:00Z', transit: true });
  expect(incomingShips([{ ...transit, milestones: transit.milestones.map(m => ({ ...m, status: 'complete' })) }], 'singapore')).toEqual([]);
});

test('incoming shows the reported planned or stopped state, not an assumed underway status', () => {
  expect(arrivalStatus({ ...base, voyage: voyage('planned') })).toBe('Planned');
  expect(arrivalStatus({ ...base, voyage: voyage('stopped') })).toBe('Stopped');
});
