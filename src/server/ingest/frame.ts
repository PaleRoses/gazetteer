/** One normalised AIS position report. MMSI is a number (Map<number> beats Map<string>); `at` is epoch seconds; `null` is "not available". */
export type Frame = Readonly<{
  mmsi: number; at: number; lat: number; lon: number; sogKnots: number | null; cogDeg: number | null; navStatus: number | null;
}>;

/** A feed's news: a position, a vessel's AIS ship type (cargo and tanker are 70-89), or a message that failed its edge parse (counted, never thrown). */
export type FeedEvent =
  | Readonly<{ kind: 'position'; frame: Frame }>
  | Readonly<{ kind: 'static'; mmsi: number; shipType: number }>
  | Readonly<{ kind: 'invalid' }>;

export const isCargoOrTanker = (shipType: number | undefined): boolean => shipType !== undefined && shipType >= 70 && shipType <= 89;

export const validFrame = (frame: Frame): boolean =>
  Number.isInteger(frame.mmsi) && frame.mmsi >= 100_000_000 && frame.mmsi <= 999_999_999
  && Math.abs(frame.lat) <= 90 && Math.abs(frame.lon) <= 180 && Number.isFinite(frame.at);
