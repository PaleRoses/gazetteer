import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Comment, User, Workspace } from "../shared";

export type AccessError = "invalid_input" | "email_in_use" | "invalid_credentials" | "unauthenticated" | "forbidden" | "not_found" | "invalid_invitation" | "already_member";
export type Result<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: AccessError }>;
export type Member = User & Readonly<{ role: "owner" | "member" }>;
export type Session = Readonly<{ user: User; token: string; expiresAt: string }>;
export type Invitation = Readonly<{ id: string; email: string; token: string; expiresAt: string }>;
type Account = User & Readonly<{ passwordHash: string }>;

const success = <T>(value: T): Result<T> => ({ ok: true, value });
const failure = <T>(error: AccessError): Result<T> => ({ ok: false, error });
const digest = (token: string): string => createHash("sha256").update(token).digest("hex");
const secret = (): string => randomBytes(32).toString("base64url");
const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const validEmail = (email: string): boolean => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validText = (value: string, max: number): boolean => value.trim().length > 0 && value.trim().length <= max;
const publicUser = ({ id, email, name }: User): User => ({ id, email, name });
const expiration = (): string => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

/** SQLite is the access-control authority. Callers supply IDs only from validated sessions. */
export const createAccess = (databasePath: string) => {
  const db = new Database(databasePath, { create: true, strict: true });
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memberships (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id), user_id TEXT NOT NULL REFERENCES accounts(id),
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')), PRIMARY KEY(workspace_id, user_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES accounts(id), expires_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS auth_budgets (
      peer_hash TEXT PRIMARY KEY, minute INTEGER NOT NULL, attempts INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), email TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, accepted_at TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), shipment_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES accounts(id), body TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS comments_shipment ON comments(workspace_id, shipment_id, created_at);
  `);

  const allowAuth = (key: string): boolean => db.transaction((): boolean => {
    const minute = Math.floor(Date.now() / 60_000);
    db.query("DELETE FROM auth_budgets WHERE minute < ?").run(minute);
    const budget = db.query<Readonly<{ attempts: number }>, [string, number]>(`
      INSERT INTO auth_budgets(peer_hash, minute, attempts) VALUES (?, ?, 1)
      ON CONFLICT(peer_hash) DO UPDATE SET attempts = MIN(auth_budgets.attempts + 1, 21)
      RETURNING attempts
    `).get(digest(key), minute);
    return budget !== null && budget.attempts <= 20;
  })();

  const membership = (userId: string, workspaceId: string): Result<Workspace> => {
    const workspace = db.query<Workspace, [string, string]>(`
      SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id
      WHERE m.user_id = ? AND w.id = ?
    `).get(userId, workspaceId);
    return workspace ? success(workspace) : failure("forbidden");
  };

  const issueSession = (user: User): Session => {
    const token = secret();
    const expiresAt = expiration();
    db.query("INSERT INTO sessions(token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(digest(token), user.id, expiresAt);
    return { user: publicUser(user), token, expiresAt };
  };

  const createWorkspace = (userId: string, name: string): Result<Workspace> => {
    if (!validText(name, 100)) return failure("invalid_input");
    if (!db.query("SELECT id FROM accounts WHERE id = ?").get(userId)) return failure("unauthenticated");
    const workspace: Workspace = { id: randomUUID(), name: name.trim(), role: "owner" };
    return db.transaction((): Result<Workspace> => {
      db.query("INSERT INTO workspaces(id, name) VALUES (?, ?)").run(workspace.id, workspace.name);
      db.query("INSERT INTO memberships(workspace_id, user_id, role) VALUES (?, ?, 'owner')").run(workspace.id, userId);
      return success(workspace);
    })();
  };

  const signup = async (input: Readonly<{ email: string; password: string; name: string; workspaceName?: string }>): Promise<Result<Session>> => {
    const email = normalizeEmail(input.email);
    const workspaceName = input.workspaceName?.trim() || `${input.name.trim()}'s workspace`;
    if (!validEmail(email) || !validText(input.name, 80) || input.password.length < 12 || input.password.length > 1024 || !validText(workspaceName, 100)) return failure("invalid_input");
    const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
    const user: User = { id: randomUUID(), email, name: input.name.trim() };
    return db.transaction((): Result<Session> => {
      const inserted = db.query("INSERT OR IGNORE INTO accounts(id, email, name, password_hash) VALUES (?, ?, ?, ?)").run(user.id, user.email, user.name, passwordHash);
      if (inserted.changes === 0) return failure("email_in_use");
      createWorkspace(user.id, workspaceName);
      return success(issueSession(user));
    })();
  };

  const login = async (input: Readonly<{ email: string; password: string }>): Promise<Result<Session>> => {
    if (!validEmail(normalizeEmail(input.email)) || input.password.length > 1024) return failure("invalid_credentials");
    const account = db.query<Account, [string]>("SELECT id, email, name, password_hash AS passwordHash FROM accounts WHERE email = ?").get(normalizeEmail(input.email));
    if (!account || !(await Bun.password.verify(input.password, account.passwordHash))) return failure("invalid_credentials");
    return success(issueSession(account));
  };

  /** Sign-in without a password for the localhost demo operator: created once with a random, never-shown password, then reused. */
  const demoSession = async (input: Readonly<{ email: string; name: string; workspaceName: string }>): Promise<Result<Session>> => {
    const created = await signup({ ...input, password: secret() });
    if (created.ok || created.error !== "email_in_use") return created;
    const account = db.query<User, [string]>("SELECT id, email, name FROM accounts WHERE email = ?").get(normalizeEmail(input.email));
    return account ? success(issueSession(account)) : failure("invalid_input");
  };

  const session = (token: string | undefined): Result<User> => {
    if (!token || token.length > 128) return failure("unauthenticated");
    const user = db.query<User, [string, string]>(`
      SELECT a.id, a.email, a.name FROM accounts a JOIN sessions s ON s.user_id = a.id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(digest(token), new Date().toISOString());
    return user ? success(user) : failure("unauthenticated");
  };

  const workspaces = (userId: string): Result<readonly Workspace[]> =>
    db.query("SELECT id FROM accounts WHERE id = ?").get(userId)
      ? success(db.query<Workspace, [string]>("SELECT w.id, w.name, m.role FROM workspaces w JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.name, w.id").all(userId))
      : failure("unauthenticated");

  const members = (userId: string, workspaceId: string): Result<readonly Member[]> => {
    const access = membership(userId, workspaceId);
    return access.ok ? success(db.query<Member, [string]>("SELECT a.id, a.email, a.name, m.role FROM accounts a JOIN memberships m ON m.user_id = a.id WHERE m.workspace_id = ? ORDER BY m.role DESC, a.name").all(workspaceId)) : access;
  };

  const invite = (userId: string, workspaceId: string, inputEmail: string): Result<Invitation> => {
    const access = membership(userId, workspaceId);
    if (!access.ok || access.value.role !== "owner") return failure("forbidden");
    const email = normalizeEmail(inputEmail);
    if (!validEmail(email)) return failure("invalid_input");
    if (db.query("SELECT a.id FROM accounts a JOIN memberships m ON m.user_id = a.id WHERE m.workspace_id = ? AND a.email = ?").get(workspaceId, email)) return failure("already_member");
    const invitation: Invitation = { id: randomUUID(), email, token: secret(), expiresAt: expiration() };
    db.transaction(() => {
      db.query("DELETE FROM invitations WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL").run(workspaceId, email);
      db.query("INSERT INTO invitations(id, workspace_id, email, token_hash, expires_at) VALUES (?, ?, ?, ?, ?)").run(invitation.id, workspaceId, email, digest(invitation.token), invitation.expiresAt);
    })();
    return success(invitation);
  };

  const acceptInvite = (userId: string, token: string): Result<Workspace> => db.transaction((): Result<Workspace> => {
    if (!token || token.length > 128) return failure("invalid_invitation");
    const invitation = db.query<Readonly<{ id: string; workspaceId: string }>, [string, string, string]>(`
      SELECT i.id, i.workspace_id AS workspaceId FROM invitations i JOIN accounts a ON a.email = i.email
      WHERE a.id = ? AND i.token_hash = ? AND i.accepted_at IS NULL AND i.expires_at > ?
    `).get(userId, digest(token), new Date().toISOString());
    if (!invitation) return failure("invalid_invitation");
    db.query("INSERT OR IGNORE INTO memberships(workspace_id, user_id, role) VALUES (?, ?, 'member')").run(invitation.workspaceId, userId);
    db.query("UPDATE invitations SET accepted_at = ? WHERE id = ?").run(new Date().toISOString(), invitation.id);
    return membership(userId, invitation.workspaceId);
  })();

  const comments = (userId: string, workspaceId: string, shipmentId: string): Result<readonly Comment[]> => {
    const access = membership(userId, workspaceId);
    if (!access.ok) return access;
    return success(db.query<Comment, [string, string]>(`
      SELECT c.id, c.body, c.created_at AS createdAt, a.name AS author
      FROM comments c JOIN accounts a ON a.id = c.user_id WHERE c.workspace_id = ? AND c.shipment_id = ?
      ORDER BY c.created_at, c.rowid
    `).all(workspaceId, shipmentId));
  };

  const comment = (userId: string, workspaceId: string, shipmentId: string, body: string): Result<Comment> => {
    const access = membership(userId, workspaceId);
    if (!access.ok) return access;
    if (!validText(shipmentId, 200) || !validText(body, 4000)) return failure("invalid_input");
    const author = db.query<User, [string]>("SELECT id, email, name FROM accounts WHERE id = ?").get(userId);
    if (!author) return failure("unauthenticated");
    const entry: Comment = { id: randomUUID(), body: body.trim(), createdAt: new Date().toISOString(), author: author.name };
    db.query("INSERT INTO comments(id, workspace_id, shipment_id, user_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(entry.id, workspaceId, shipmentId, userId, entry.body, entry.createdAt);
    return success(entry);
  };

  return {
    allowAuth, signup, login, demoSession, session, workspaces, createWorkspace, membership, members, invite, acceptInvite, comments, comment,
    workspaceIds: (): readonly string[] => db.query<Readonly<{ id: string }>, []>('SELECT id FROM workspaces ORDER BY id').all().map(workspace => workspace.id),
    logout: (token: string): Result<null> => { db.query("DELETE FROM sessions WHERE token_hash = ?").run(digest(token)); return success(null); },
    close: (): void => db.close(),
  };
};

export type Access = ReturnType<typeof createAccess>;
