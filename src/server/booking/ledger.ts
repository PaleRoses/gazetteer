import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/*
 * The sandbox reservation ledger. Nothing here books anything in the world: it is the record the demo's agents hold, confirm and release
 * against, so every claim they make is a row with a status. SQLite is the authority and the only state; every operation takes the clock
 * from the ledger's `now`, so expiry is decided in one place.
 */

type BookingStatus = 'held' | 'confirmed' | 'released' | 'expired';
type BookingError = 'invalid_input' | 'key_conflict' | 'resource_taken' | 'not_found' | 'expired' | 'not_held';
export type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: BookingError }>;
export type Booking = Readonly<{
  id: string; caseId: string; resource: string; start: string; end: string; priceEur: number;
  status: BookingStatus; expiresAt: string; heldBy: string; confirmedAt: string | null;
}>;

const instant = z.iso.datetime();
const holdInput = z.object({
  key: z.string().trim().min(1).max(200), workspaceId: z.string().trim().min(1).max(100), caseId: z.string().trim().min(1).max(200),
  resource: z.string().trim().min(1).max(200), start: instant, end: instant, priceEur: z.number().finite().min(0).max(1_000_000),
  expiresAt: instant, heldBy: z.string().trim().min(1).max(200),
}).refine(input => Date.parse(input.end) > Date.parse(input.start), 'end must be after start');
export type HoldInput = z.input<typeof holdInput>;

type Row = Readonly<{
  id: string; key: string; workspace_id: string; case_id: string; resource: string; start_at: string; end_at: string; price_cents: number;
  status: BookingStatus; expires_at: string; held_by: string; confirmed_at: string | null;
}>;

/**
 * The actors' bundler (esbuild) cannot resolve `bun:` built-ins and Bun 1.3 has no `node:sqlite`, so the driver is loaded by a specifier it cannot
 * see. The server and the actors share one ledger file this way.
 */
const { Database } = await import(['bun', 'sqlite'].join(':')) as typeof import('bun:sqlite');

const success = <T>(value: T): Result<T> => ({ ok: true, value });
const failure = <T>(error: BookingError): Result<T> => ({ ok: false, error });
const iso = (millis: number): string => new Date(millis).toISOString();

/** A hold whose time has passed is expired whether or not the sweep has recorded it yet. */
const effective = (row: Row, nowIso: string): BookingStatus => row.status === 'held' && row.expires_at <= nowIso ? 'expired' : row.status;
const record = (row: Row, nowIso: string): Booking => ({
  id: row.id, caseId: row.case_id, resource: row.resource, start: row.start_at, end: row.end_at, priceEur: row.price_cents / 100,
  status: effective(row, nowIso), expiresAt: row.expires_at, heldBy: row.held_by, confirmedAt: row.confirmed_at,
});

export const createBookings = (databasePath: string, now: () => number = Date.now) => {
  const db = new Database(databasePath, { create: true, strict: true });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS bookings (
      id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL, case_id TEXT NOT NULL, resource TEXT NOT NULL,
      start_at TEXT NOT NULL, end_at TEXT NOT NULL, price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
      status TEXT NOT NULL CHECK (status IN ('held', 'confirmed', 'released', 'expired')),
      expires_at TEXT NOT NULL, held_by TEXT NOT NULL, confirmed_at TEXT, released_at TEXT
    ) STRICT;
    CREATE INDEX IF NOT EXISTS bookings_workspace ON bookings (workspace_id, start_at);
    CREATE INDEX IF NOT EXISTS bookings_resource ON bookings (resource, start_at);
  `);
  const byKey = db.query<Row, [string]>('SELECT * FROM bookings WHERE key = ?');
  const byId = db.query<Row, [string]>('SELECT * FROM bookings WHERE id = ?');
  const insert = db.query('INSERT INTO bookings (id, key, workspace_id, case_id, resource, start_at, end_at, price_cents, status, expires_at, held_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, \'held\', ?, ?)');
  const clash = db.query<{ id: string }, [string, string, string, string]>(
    'SELECT id FROM bookings WHERE resource = ? AND start_at < ? AND end_at > ? AND (status = \'confirmed\' OR (status = \'held\' AND expires_at > ?)) LIMIT 1');
  const lapse = db.query('UPDATE bookings SET status = \'expired\' WHERE status = \'held\' AND expires_at <= ?');
  const list = db.query<Row, [string]>('SELECT * FROM bookings WHERE workspace_id = ? ORDER BY start_at, id');

  const sweep = (): number => lapse.run(iso(now())).changes;

  /** Idempotent by key: the same key with the same terms is the same record, whatever has happened to it since; the same key with other terms is refused. */
  const hold = (raw: HoldInput): Result<Booking> => {
    const parsed = holdInput.safeParse(raw);
    if (!parsed.success) return failure('invalid_input');
    const input = parsed.data;
    const at = iso(now());
    const cents = Math.round(input.priceEur * 100);
    const existing = byKey.get(input.key);
    if (existing) {
      const same = existing.workspace_id === input.workspaceId && existing.case_id === input.caseId && existing.resource === input.resource
        && existing.start_at === input.start && existing.end_at === input.end && existing.price_cents === cents;
      return same ? success(record(existing, at)) : failure('key_conflict');
    }
    if (input.expiresAt <= at) return failure('invalid_input');
    sweep();
    if (clash.get(input.resource, input.end, input.start, at)) return failure('resource_taken');
    const id = `bk_${randomUUID()}`;
    insert.run(id, input.key, input.workspaceId, input.caseId, input.resource, input.start, input.end, cents, input.expiresAt, input.heldBy);
    return success(record(byId.get(id)!, at));
  };

  /** Idempotent: confirming a confirmed booking returns it. A hold past its time is expired and refused. */
  const confirm = (id: string): Result<Booking> => {
    const row = byId.get(id);
    const at = iso(now());
    if (!row) return failure('not_found');
    if (row.status === 'confirmed') return success(record(row, at));
    if (row.status !== 'held') return failure(row.status === 'expired' ? 'expired' : 'not_held');
    if (row.expires_at <= at) { sweep(); return failure('expired'); }
    db.query('UPDATE bookings SET status = \'confirmed\', confirmed_at = ? WHERE id = ?').run(at, id);
    return success(record(byId.get(id)!, at));
  };

  /** Idempotent: releasing a released booking returns it; an expired hold is already gone and is returned as is. A confirmed booking can be released (cancelled). */
  const release = (id: string): Result<Booking> => {
    const row = byId.get(id);
    const at = iso(now());
    if (!row) return failure('not_found');
    if (row.status === 'held' || row.status === 'confirmed') {
      if (row.status === 'held' && row.expires_at <= at) { sweep(); return success(record(byId.get(id)!, at)); }
      db.query('UPDATE bookings SET status = \'released\', released_at = ? WHERE id = ?').run(at, id);
      return success(record(byId.get(id)!, at));
    }
    return success(record(row, at));
  };

  return {
    hold, confirm, release, sweep,
    /** The record an idempotency key made, whatever has happened to it since. */
    find: (key: string): Booking | undefined => { const row = byKey.get(key); return row ? record(row, iso(now())) : undefined; },
    /** Whether a window on a resource is free of live holds and confirmed bookings. */
    free: (resource: string, start: string, end: string): boolean => { sweep(); return clash.get(resource, end, start, iso(now())) === null; },
    get: (id: string): Booking | undefined => { const row = byId.get(id); return row ? record(row, iso(now())) : undefined; },
    list: (workspaceId: string): readonly Booking[] => { sweep(); return list.all(workspaceId).map(row => record(row, iso(now()))); },
    close: (): void => db.close(),
  };
};
export type Bookings = ReturnType<typeof createBookings>;

const open = new Map<string, Bookings>();
/** One connection per file for the life of the process, for actors and the server alike: SQLite in WAL mode shares a file safely between processes. */
export const ledgerAt = (path: string): Bookings => open.get(path) ?? (() => { const created = createBookings(path); open.set(path, created); return created; })();
