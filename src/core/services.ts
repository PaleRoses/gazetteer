import { portIds, type PortId } from './ports.js';
import type { Commitments, Offer } from './recovery.js';
import type { Shipment } from './types.js';

/**
 * Act 2's sandbox world: one refrigerated container aboard Meridian Star, Rotterdam's terminal desk and its haulier.
 * The terminal, the haulier and the consignee are fictional; the port (Rotterdam) and the road (Rotterdam to Venlo) are real.
 * No operator quoted these prices or times. Every time is hours after the anchor, Meridian Star's original arrival at
 * Rotterdam on the scenario clock, so the story replays from any start; with the anchor at 10:00 the clock reads as the
 * act 2 storyboard does.
 */
const sandboxBasis = 'Sandbox: fictional terminal desk, haulier and consignee; real port (Rotterdam) and real road (Rotterdam to Venlo). No operator quoted these prices or times.';

const hourMs = 3_600_000;
const at = (anchor: string, hours: number): string => new Date(Date.parse(anchor) + hours * hourMs).toISOString();
const hoursBetween = (from: string, until: string): number => (Date.parse(until) - Date.parse(from)) / hourMs;

/** The cargo aboard and what it is owed. Declared for the demo. */
export const reeferAboard = {
  shipmentId: 'gz-1042', vessel: 'Meridian Star', port: 'rotterdam',
  /** ISO 6346: owner MSTU, category U, serial 418265, check digit 1. The owner code is not checked against the BIC register. */
  container: 'MSTU4182651',
  goods: 'chilled produce', setpointCelsius: 2, reefer: true, consignee: 'Venlo DC', budgetEur: 1_800,
  /** The delay act 2 opens on (16:00 against a 10:00 plan), the haul booked before it (14:00) and the consignee's cut-off (23:30). */
  delayHours: 6, truckAppointmentHours: 4, deliverByHours: 13.5,
  basis: 'Declared: a reefer at +2 °C that must reach Venlo DC by 23:30 on a EUR 1,800 budget, kept on power throughout.',
} as const;

type Unload = Readonly<{ id: string; atHours: number; priceEur: number }>;
type Plug = Readonly<{ id: string; fromHours: number; untilHours: number; eurPerHour: number; minimumHours: number }>;
type TerminalDesk = Readonly<{ unloads: readonly Unload[]; plugs: readonly Plug[]; offerTtlMinutes: number; basis: string }>;
type Haulier = Readonly<{ destination: string; transitHours: number; trucks: readonly Readonly<{ id: string; departsHours: number; priceEur: number }>[]; basis: string }>;

/** Rotterdam's terminal desk: the first crane window after the delayed arrival, and one powered plug billed by the hour. */
const rotterdamDesk: TerminalDesk = {
  unloads: [{ id: 'unload-1800', atHours: 8, priceEur: 140 }],
  plugs: [{ id: 'R-114', fromHours: 8, untilHours: 14, eurPerHour: 95, minimumHours: 1 }],
  offerTtlMinutes: 30,
  basis: `${sandboxBasis} Unload at 18:00 for EUR 140; reefer plug R-114 free 18:00 to midnight at EUR 95 an hour, one hour minimum; an offer stands for 30 minutes.`,
};
const terminalDesks: Partial<Record<PortId, TerminalDesk>> = { rotterdam: rotterdamDesk };

/** Rotterdam's haulier: three reefer departures for Venlo, two hours fifteen on the road. */
const rotterdamHaulier: Haulier = {
  destination: 'Venlo DC', transitHours: 2.25,
  trucks: [{ id: 'truck-1700', departsHours: 7, priceEur: 640 }, { id: 'truck-1930', departsHours: 9.5, priceEur: 720 }, { id: 'truck-2100', departsHours: 11, priceEur: 760 }],
  basis: `${sandboxBasis} Reefer trucks leave at 17:00 (EUR 640), 19:30 (EUR 720) and 21:00 (EUR 760); Rotterdam to Venlo is 2 h 15 min.`,
};
const hauliers: Partial<Record<PortId, Haulier>> = { rotterdam: rotterdamHaulier };

/** The sandbox agents stationed at a city, read off the desk and haulier tables: Rotterdam has both, every other city none. */
export const servicesAt = (city: PortId): readonly ('terminal' | 'haulier')[] => [...(terminalDesks[city] ? ['terminal' as const] : []), ...(hauliers[city] ? ['haulier' as const] : [])];

/** Meridian Star's original arrival at Rotterdam on the scenario clock, on the hour: every act 2 time is counted from it. */
export const act2Anchor = (shipment: Pick<Shipment, 'baselineEta'>): string => {
  const ms = Date.parse(shipment.baselineEta);
  return new Date(ms - ms % hourMs).toISOString();
};

/** What the cargo agent remembers it owes. The arrival defaults to the declared delay; pass the ship's revised ETA to follow it instead. */
export const reeferCommitments = (anchor: string, arrival: string = at(anchor, reeferAboard.delayHours)): Commitments => ({
  cargoId: `${reeferAboard.shipmentId}:${reeferAboard.container}`, shipmentId: reeferAboard.shipmentId, vessel: reeferAboard.vessel, container: reeferAboard.container,
  port: reeferAboard.port, arrival, deliverBy: at(anchor, reeferAboard.deliverByHours), transitHours: rotterdamHaulier.transitHours,
  budgetEur: reeferAboard.budgetEur, reefer: reeferAboard.reefer, truckAppointment: at(anchor, reeferAboard.truckAppointmentHours),
});

export type Departure = Readonly<{ id: string; departs: string; priceEur: number; arrives: string; destination: string }>;

/** A city's truck departures, earliest first; a city without a haulier has none. */
export const trucksFor = (city: PortId, anchor: string): readonly Departure[] => {
  const haulier = hauliers[city];
  return haulier ? haulier.trucks.map(truck => ({ id: truck.id, departs: at(anchor, truck.departsHours), priceEur: truck.priceEur, arrives: at(anchor, truck.departsHours + haulier.transitHours), destination: haulier.destination }))
    .toSorted((a, b) => Date.parse(a.departs) - Date.parse(b.departs)) : [];
};

const storageOfferId = (city: PortId, plugId: string, from: string, until: string): string => `${city}:storage:${plugId}:${from}/${until}`;
const storagePattern = /^([a-z-]+):storage:([^:]+):[^/]+\/.+$/;

/** The ledger resource a storage offer occupies, `${city}:plug:${plugId}`: overlapping intervals on one plug are one resource. Null for any other offer id. */
export const plugOf = (offerId: string): string | null => {
  const [, city, plugId] = storagePattern.exec(offerId) ?? [];
  return city && plugId && (portIds as readonly string[]).includes(city) ? `${city}:plug:${plugId}` : null;
};

export type TerminalRequest = Readonly<{ service: 'unload' | 'storage'; after?: string; until?: string }>;

/**
 * Pure: the terminal desk's answer to a request, or null when it has nothing. Unload: the first window at or after `after`.
 * Storage: plug power from the later of `after` and the plug's first free hour, until `until` (or the minimum booking when none is asked),
 * priced by the hour. Offer ids name the interval, so an extension is a new offer and the first one can still be released.
 */
export function terminalQuote(city: PortId, anchor: string, request: TerminalRequest, now: string): Offer | null {
  const desk = terminalDesks[city];
  if (!desk) return null;
  const provider = { role: 'city' as const, city, element: 'terminal' as const };
  const expiresAt = new Date(Date.parse(now) + desk.offerTtlMinutes * 60_000).toISOString();
  const after = request.after ?? now;
  if (request.service === 'unload') {
    const window = desk.unloads.find(item => Date.parse(at(anchor, item.atHours)) >= Date.parse(after));
    return window ? { service: 'unload', id: `${city}:unload:${window.id}`, provider, at: at(anchor, window.atHours), priceEur: window.priceEur, expiresAt } : null;
  }
  return desk.plugs.reduce<Offer | null>((found, plug) => {
    if (found) return found;
    const from = Date.parse(after) > Date.parse(at(anchor, plug.fromHours)) ? new Date(Date.parse(after)).toISOString() : at(anchor, plug.fromHours);
    const wanted = request.until ?? new Date(Date.parse(from) + plug.minimumHours * hourMs).toISOString();
    const until = Date.parse(wanted) < Date.parse(at(anchor, plug.untilHours)) ? new Date(Date.parse(wanted)).toISOString() : at(anchor, plug.untilHours);
    const hours = Math.max(plug.minimumHours, hoursBetween(from, until));
    return hoursBetween(from, until) > 0
      ? { service: 'storage', id: storageOfferId(city, plug.id, from, until), provider, powered: true, from, until, priceEur: Math.round(hours * plug.eurPerHour * 100) / 100, expiresAt }
      : null;
  }, null);
}
