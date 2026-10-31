/*
 * Every number the ingest path decides, with its basis. None is a fitted result: "estimate" means this lane's choice, and the bench
 * (scripts/bench-ingest.ts) is the check on the ones that govern cost (the delivery gate, the ring budget).
 */

/** AIS ship types 70-79 (cargo) and 80-89 (tanker), ITU-R M.1371. Port counts are of these; unknown types are excluded and counted as unclassified. */
export const cargoTankerTypes = { from: 70, to: 89 } as const;

/** Nine-digit MMSIs are vessels; 0-8 digit and 10+ digit values are base stations, SAR aircraft, or noise, and the real MarineCadastre day has thousands of them. */
export const mmsiRange = { min: 100_000_000, max: 999_999_999 } as const;

export const zones = {
  /** Anchorage and outer radius: the 30 km / 40 km pair in agents/port/risk.ts, which scales GFW pipe-anchorages' 3 km / 4 km entry/exit ratio to a container port's offshore anchorage. Estimate of the scale, GFW's ratio. */
  anchorageKm: 30, outerKm: 40,
  /** Berth radius: estimate. LA/LB, the one port with data in hand, shows moored vessels (Status 5) well inside 5 km of the reference point; replaced by AIS-derived cells once a baseline exists. */
  berthKm: 5,
  /** H3 resolution 7: edge 1.22 km, so the 5 km berth radius spans several cells and a 40 km disk is about 1,100 cells a port. */
  resolution: 7,
  /** Resolution-7 cell centres are about 2.12 km apart (edge 1.22 km x sqrt 3): this many grid rings cover the outer radius. */
  centreSpacingKm: 2.12,
  /** Port watch box = outer radius plus 10%, in degrees (111 km a degree of latitude): a cheap test before any hashing. */
  boxMargin: 1.1, kmPerDegree: 111,
} as const;

/** A stop in the anchorage counts as anchored only after this long stationary, so ships slowing through are not queued. Estimate. */
export const anchoredMinDwellSeconds = 30 * 60;

export const ring = {
  /** One point a minute: a 500 m significance gate and GFW's hourly loitering buckets both need no finer history. */
  stepSeconds: 60,
  /** 24 h at one point a minute. */
  capacity: 24 * 60,
  /** 64 MiB / 34.5 KiB a ring (24 bytes a point x 1,440), rounded down. */
  maxRings: 1800,
} as const;

export const gate = {
  /** 500 m is 1 minute at 16 knots, so an underway vessel is delivered about once a minute while an anchored vessel swinging on its cable (radius well under 500 m) is not. Estimate. */
  significantMoveMeters: 500,
  /** Ten minutes is three missed class A at-anchor reports (3 min interval): a quiet vessel re-proves liveness without a delivery per report. Estimate. */
  heartbeatSeconds: 600,
} as const;

export const memory = {
  /** 6 h is 120 class A at-anchor reports (3 min interval): a vessel silent for that long is gone, not slow. Estimate. */
  vesselTtlSeconds: 6 * 3600,
  /** 1 h window for "vessels the feed is carrying now". */
  activeWindowSeconds: 3600,
  /** Larger than the cargo and tanker fleet broadcasting at once (estimate: tens of thousands); insertion-order eviction past it. */
  shipTypeCapacity: 200_000,
} as const;

export const feed = {
  /** Actors wake every 60 s (agents checkIntervalMs); a 5 s flush keeps delivery latency an order of magnitude below that. */
  flushMillis: 5_000,
  /** 8,192 events is ~15 s of the worst measured nationwide peak (524 msg/s, MarineCadastre 2023-06-15) before the sliding queue drops the oldest. */
  bufferSize: 8_192,
  /** Retry from 1 s, jittered, capped at 60 s. */
  reconnectBaseSeconds: 1, reconnectCapSeconds: 60,
  /** MQTT connect gave first message in 0.7 s when probed; 15 s is a failure, not slowness. */
  connectTimeoutMillis: 15_000,
} as const;
