/** Every number the haulier decides, with its basis. Estimates are this lane's choices, not data. */
export const haulier = {
  /** A truck offer stays good for half an hour: long enough for a cargo agent to compare terminal and haulier replies, short enough that a stale truck is not promised. Estimate. */
  offerTtlMinutes: 30,
  /** The window a truck counts as busy when the haulier checks the ledger before offering it: the hour from departure. The cargo agent books the whole haul, so any booking overlaps it. Estimate. */
  slotMinutes: 60,
  /** Request ids remembered so a replayed board is answered once: the board's own history window is a few hundred messages (inbox capacity 500). */
  seenCapacity: 500,
} as const;
