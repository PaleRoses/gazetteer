import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccess, type Result } from "../src/server/access";

const unwrap = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`Unexpected failure: ${result.error}`);
  return result.value;
};
const account = (name: string) => ({ email: `${name}@example.com`, name, password: "correct horse battery staple" });

describe("workspace access", () => {
  test("limits auth attempts per trusted peer", () => {
    const access = createAccess(":memory:");
    expect(Array.from({ length: 20 }, () => access.allowAuth("127.0.0.1"))).toEqual(Array.from({ length: 20 }, () => true));
    expect(access.allowAuth("127.0.0.1")).toBe(false);
    expect(access.allowAuth("127.0.0.1")).toBe(false);
    expect(access.allowAuth("127.0.0.2")).toBe(true);
    access.close();
  });

  test("accounts, shared comments and sessions survive restart; secrets are hashed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gazetteer-access-"));
    const path = join(directory, "access.sqlite");
    const access = createAccess(path);
    const owner = unwrap(await access.signup(account("owner")));
    const member = unwrap(await access.signup(account("member")));
    const workspace = unwrap(access.workspaces(owner.user.id))[0];
    expect(workspace).toBeDefined();
    if (!workspace) throw new Error("Owner workspace missing");
    const invitation = unwrap(access.invite(owner.user.id, workspace.id, member.user.email));
    expect(unwrap(access.acceptInvite(member.user.id, invitation.token)).role).toBe("member");
    expect(access.workspaceIds()).toHaveLength(2);
    expect(access.workspaceIds()).toContain(workspace.id);
    const entry = unwrap(access.comment(member.user.id, workspace.id, "GZ-1042", "Check the revised berth window."));
    expect(unwrap(access.comments(owner.user.id, workspace.id, "GZ-1042"))).toEqual([entry]);
    access.close();
    const reopened = createAccess(path);
    expect(unwrap(reopened.session(owner.token))).toEqual(owner.user);
    expect(unwrap(reopened.comments(member.user.id, workspace.id, "GZ-1042"))).toEqual([entry]);
    expect(unwrap(await reopened.login(account("member"))).user).toEqual(member.user);
    const inspect = new Database(path);
    expect(inspect.query<{ token_hash: string }, []>("SELECT token_hash FROM sessions").all().every(row => row.token_hash !== owner.token && row.token_hash !== member.token)).toBe(true);
    expect(inspect.query<{ token_hash: string }, []>("SELECT token_hash FROM invitations").get()?.token_hash).not.toBe(invitation.token);
    inspect.close();
    expect(reopened.logout(owner.token).ok).toBe(true);
    expect(reopened.session(owner.token)).toEqual({ ok: false, error: "unauthenticated" });
    reopened.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("rejects cross-workspace access, wrong-email invitations, reuse and member invitations", async () => {
    const access = createAccess(":memory:");
    const owner = unwrap(await access.signup(account("owner")));
    const member = unwrap(await access.signup(account("member")));
    const outsider = unwrap(await access.signup(account("outsider")));
    const workspace = unwrap(access.workspaces(owner.user.id))[0];
    if (!workspace) throw new Error("Owner workspace missing");
    expect(access.members(outsider.user.id, workspace.id)).toEqual({ ok: false, error: "forbidden" });
    expect(access.comments(outsider.user.id, workspace.id, "GZ-1042")).toEqual({ ok: false, error: "forbidden" });
    expect(access.comment(outsider.user.id, workspace.id, "GZ-1042", "Unauthorized")).toEqual({ ok: false, error: "forbidden" });
    expect(access.invite(outsider.user.id, workspace.id, outsider.user.email)).toEqual({ ok: false, error: "forbidden" });
    const invitation = unwrap(access.invite(owner.user.id, workspace.id, " MEMBER@example.com "));
    expect(access.acceptInvite(outsider.user.id, invitation.token)).toEqual({ ok: false, error: "invalid_invitation" });
    expect(access.acceptInvite(member.user.id, "wrong-token")).toEqual({ ok: false, error: "invalid_invitation" });
    expect(access.acceptInvite(member.user.id, invitation.token).ok).toBe(true);
    expect(access.acceptInvite(member.user.id, invitation.token)).toEqual({ ok: false, error: "invalid_invitation" });
    expect(access.invite(member.user.id, workspace.id, outsider.user.email)).toEqual({ ok: false, error: "forbidden" });
    expect(unwrap(access.members(member.user.id, workspace.id)).map(user => user.role).sort()).toEqual(["member", "owner"]);
    expect(access.invite(owner.user.id, workspace.id, member.user.email)).toEqual({ ok: false, error: "already_member" });
    access.close();
  });

  test("rejects invalid signup/login and replaces outstanding invitations without leaking tokens", async () => {
    const access = createAccess(":memory:");
    expect(await access.signup({ ...account("owner"), password: "short" })).toEqual({ ok: false, error: "invalid_input" });
    const owner = unwrap(await access.signup(account("owner")));
    expect(await access.signup({ ...account("owner"), email: "OWNER@example.com" })).toEqual({ ok: false, error: "email_in_use" });
    expect(await access.login({ ...account("owner"), password: "wrong" })).toEqual({ ok: false, error: "invalid_credentials" });
    const workspace = unwrap(access.workspaces(owner.user.id))[0];
    if (!workspace) throw new Error("Owner workspace missing");
    const first = unwrap(access.invite(owner.user.id, workspace.id, "member@example.com"));
    const second = unwrap(access.invite(owner.user.id, workspace.id, "member@example.com"));
    expect(first.token).not.toBe(second.token);
    const member = unwrap(await access.signup(account("member")));
    expect(access.acceptInvite(member.user.id, first.token)).toEqual({ ok: false, error: "invalid_invitation" });
    expect(access.acceptInvite(member.user.id, second.token).ok).toBe(true);
    expect(access.comment(owner.user.id, workspace.id, "GZ-1042", "   ")).toEqual({ ok: false, error: "invalid_input" });
    access.close();
  });
});
