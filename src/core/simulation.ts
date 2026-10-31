import { shiftEta } from './eta.js';
import type { PortId } from './ports.js';
import type { Risk, Shipment } from './types.js';

export const disruptionScenarios = [
  { id: 'congestion', label: 'Berth congestion', hours: 12, description: 'An assumed queue delays discharge at the destination port.' },
  { id: 'weather', label: 'Severe weather', hours: 24, description: 'An assumed weather hold suspends destination port operations.' },
  { id: 'closure', label: 'Terminal closure', hours: 36, description: 'An assumed terminal closure postpones discharge.' },
] as const;
export type SimulationInput = Readonly<{ scenario: typeof disruptionScenarios[number]['id']; portId: PortId; delayHours: number }>;
export type SimulationResult = Readonly<{
  input: SimulationInput; capturedAt: string; sourceUpdatedAt: string; fleetSize: number;
  vessels: readonly Readonly<{ id: string; vessel: string; origin: PortId; destination: PortId; currentEta: string; scenarioEta: string; risk: Risk }>[];
}>;

/** A detached projection, never a Shipment or an event that the live runtime can ingest. */
export function simulateDisruption(shipments: readonly Shipment[], input: SimulationInput, sourceUpdatedAt: string, now = new Date()): SimulationResult {
  if (!Number.isInteger(input.delayHours) || input.delayHours < 1 || input.delayHours > 168) throw new Error('Choose a delay from 1 to 168 hours.');
  return {
    input: { ...input }, capturedAt: now.toISOString(), sourceUpdatedAt, fleetSize: shipments.length,
    vessels: shipments.filter(ship => ship.destination === input.portId && ship.voyage?.status !== 'arrived' && Date.parse(ship.eta) > now.getTime()).map(ship => ({
      id: ship.id, vessel: ship.vessel, origin: ship.origin, destination: ship.destination, currentEta: ship.eta,
      // Start at the current estimate, including any existing operational delays.
      scenarioEta: shiftEta({ ...ship, baselineEta: ship.eta, delayHours: 0 }, input.delayHours).eta,
      risk: ship.risk === 'delayed' || ship.delayHours + input.delayHours >= 24 ? 'delayed' : 'watch',
    })),
  };
}
