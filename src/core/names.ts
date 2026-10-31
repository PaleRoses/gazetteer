/**
 * The minds aboard the ships: the 57 navigational stars of celestial navigation, in catalogue order, then Polaris.
 * A ship's mind is a pure function of its fixed place in the fleet, so a restart or a longer fleet never renames anyone.
 * Ports keep the names of their cities; their agents are named by the element they watch, not by a persona.
 */
export const shipMinds = [
  'Alpheratz', 'Ankaa', 'Schedar', 'Diphda', 'Achernar', 'Hamal', 'Acamar', 'Menkar', 'Mirfak', 'Aldebaran', 'Rigel', 'Capella', 'Bellatrix', 'Elnath',
  'Alnilam', 'Betelgeuse', 'Canopus', 'Sirius', 'Adhara', 'Procyon', 'Pollux', 'Avior', 'Suhail', 'Miaplacidus', 'Alphard', 'Regulus', 'Dubhe', 'Denebola',
  'Gienah', 'Acrux', 'Gacrux', 'Alioth', 'Spica', 'Alkaid', 'Hadar', 'Menkent', 'Arcturus', 'Rigil Kentaurus', 'Zubenelgenubi', 'Kochab', 'Alphecca', 'Antares',
  'Atria', 'Sabik', 'Shaula', 'Rasalhague', 'Eltanin', 'Kaus Australis', 'Vega', 'Nunki', 'Altair', 'Peacock', 'Deneb', 'Enif', 'Alnair', 'Fomalhaut', 'Markab', 'Polaris',
] as const;

export type ShipMindName = (typeof shipMinds)[number];

/** The mind at this place in the fleet; a fleet longer than the catalogue is a build error, never a repeated name. */
export const shipMindFor = (fleetIndex: number): ShipMindName => {
  const name = shipMinds[fleetIndex];
  if (name === undefined) throw new RangeError(`no mind left in the catalogue for fleet index ${fleetIndex}`);
  return name;
};

/** A ship persisted before ships were named is named once, from its place in the fleet; a ship that already has a mind keeps it. */
export const named = <S extends Readonly<{ id: string; agent?: string }>>(shipment: S, fleetIds: readonly string[]): S & Readonly<{ agent: string }> =>
  shipment.agent ? shipment as S & Readonly<{ agent: string }> : { ...shipment, agent: shipMindFor(Math.max(0, fleetIds.indexOf(shipment.id))) };
