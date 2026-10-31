import { describe, expect, test } from 'bun:test';
import { boardMessage } from '../../src/core/board';
import { portById, portIds, ports } from '../../src/core/ports';
import { distanceKm, type LngLat } from '../../src/core/routes';

describe('port registry', () => {
  test('ids and UN/LOCODEs are unique, and every code is a well-formed LOCODE', () => {
    expect(new Set(portIds).size).toBe(ports.length);
    expect(new Set(ports.map(port => port.locode)).size).toBe(ports.length);
    ports.forEach(port => expect(port.locode).toMatch(/^[A-Z]{2}[A-Z2-9]{3}$/));
  });

  test('ports sit apart on the globe, so no two can be confused for the nearest port', () => {
    const gaps = ports.flatMap((a, index) => ports.slice(index + 1).map(b => distanceKm(a.coordinates as LngLat, b.coordinates as LngLat)));
    expect(Math.min(...gaps)).toBeGreaterThan(50);
  });

  test('every service rate is a positive assumption with a stated basis', () => {
    ports.forEach(port => {
      expect(port.serviceRate.provenance).toBe('assumed');
      expect(port.serviceRate.perHour).toBeGreaterThan(0);
      expect(Number.isFinite(port.serviceRate.perHour)).toBe(true);
      expect(port.serviceRate.basis).toContain('TEU');
    });
    expect(portById.get('shanghai')!.serviceRate.perHour).toBeGreaterThan(portById.get('savannah')!.serviceRate.perHour);
  });

  test('the board protocol accepts a notice at every registered port and refuses an unknown one', () => {
    const eta = (portId: string) => ({ kind: 'ship.eta', id: `eta-${portId}`, author: { role: 'ship', id: 's-1', vessel: 'V' }, at: '2026-10-31T12:00:00.000Z',
      summary: 'ETA', shipmentId: 's-1', portId, eta: '2026-11-03T00:00:00.000Z', previousEta: '2026-11-01T00:00:00.000Z' });
    portIds.forEach(id => expect(boardMessage.safeParse(eta(id)).success).toBe(true));
    expect(boardMessage.safeParse(eta('atlantis')).success).toBe(false);
  });
});
