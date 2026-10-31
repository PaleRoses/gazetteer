import { z } from 'zod';
import type { Access, AccessError, Result, Session } from './access';
import type { Monitoring } from './monitoring';
export type Mail = Readonly<{ key: string; from: string }>;
type MailTransport = (request: Request) => Promise<Response>;
type InvitationDelivery = Readonly<{ delivery: 'accepted'; messageId: string }>
  | Readonly<{ delivery: 'unconfirmed'; warning: string }>;
type Options = Readonly<{ access: Access; monitoring: Pick<Monitoring, 'dashboard' | 'simulate'>; origin: string; mail?: Mail; mailTransport?: MailTransport }>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});
const accessStatus: Record<AccessError, number> = {
  invalid_input: 400, email_in_use: 409, invalid_credentials: 401, unauthenticated: 401,
  forbidden: 403, not_found: 404, invalid_invitation: 400, already_member: 409,
};
const respond = <T>(result: Result<T>, project: (value: T) => unknown = value => value): Response =>
  result.ok ? json(project(result.value)) : json({ error: result.error.replaceAll('_', ' ') }, accessStatus[result.error]);
const tokenFrom = (request: Request): string | undefined => request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('gazetteer_session='))?.slice('gazetteer_session='.length);
const email = z.string().trim().email().max(254);
const password = z.string().min(12).max(1024);
const signupSchema = z.object({ email, password, name: z.string().trim().min(1).max(80), workspaceName: z.string().trim().min(1).max(100).optional() });
const disruptionSchema = z.object({ portId: z.enum(['singapore', 'rotterdam', 'shanghai', 'los-angeles']), delayHours: z.number().int().min(1).max(168) });
const mailReceiptSchema = z.object({ id: z.string().trim().min(1) });
const bodyWith = async <T>(request: Request, schema: z.ZodType<T>, action: (body: T) => Response | Promise<Response>): Promise<Response> => {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) return json({ error: 'Expected application/json' }, 415);
  const body = schema.safeParse(await request.json().catch(() => null));
  return body.success ? action(body.data) : json({ error: 'Invalid request fields' }, 400);
};

export function createApi({ access, monitoring, origin, mail, mailTransport = fetch }: Options): (request: Request, clientKey?: string) => Promise<Response> {
  const cookie = (token: string, maxAge = 604800): string => `gazetteer_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`;
  const authenticated = (result: Result<Session>): Response => {
    if (!result.ok) return respond(result);
    const workspaces = access.workspaces(result.value.user.id);
    return workspaces.ok ? json({ user: result.value.user, workspaces: workspaces.value }, 200, { 'Set-Cookie': cookie(result.value.token) }) : respond(workspaces);
  };

  return async (request, clientKey = 'unknown') => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (request.method === 'POST' && request.headers.get('Origin') !== origin) return json({ error: 'Origin not allowed' }, 403);
    if (request.method === 'POST' && (path === '/api/signup' || path === '/api/login') && !access.allowAuth(clientKey)) return json({ error: 'Too many sign-in attempts. Try again in a minute.' }, 429, { 'Retry-After': '60' });
    if (path === '/api/signup' && request.method === 'POST') return bodyWith(request, signupSchema, async input => authenticated(await access.signup(input)));
    if (path === '/api/login' && request.method === 'POST') return bodyWith(request, z.object({ email, password: z.string().max(1024) }), async input => authenticated(await access.login(input)));

    const session = access.session(tokenFrom(request));
    if (!session.ok) return respond(session);
    const user = session.value;
    if (path === '/api/session' && request.method === 'GET') return respond(access.workspaces(user.id), workspaces => ({ user, workspaces }));
    if (path === '/api/logout' && request.method === 'POST') {
      access.logout(tokenFrom(request) ?? '');
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    }
    if (path === '/api/workspaces' && request.method === 'POST') return bodyWith(request, z.object({ name: z.string().trim().min(1).max(100) }), input => respond(access.createWorkspace(user.id, input.name)));
    if (path === '/api/invitations/accept' && request.method === 'POST') return bodyWith(request, z.object({ token: z.string().min(1).max(128) }), input => respond(access.acceptInvite(user.id, input.token)));
    const match = /^\/api\/workspaces\/([^/]+)\/(dashboard|disruptions|members|invitations|shipments\/([^/]+)\/comments)$/.exec(path);
    if (!match) return json({ error: 'Not found' }, 404);
    const workspaceId = match[1];
    const resource = match[2];
    const membership = access.membership(user.id, workspaceId);
    if (!membership.ok) return respond(membership);
    if (resource === 'dashboard' && request.method === 'GET') return json(await monitoring.dashboard(workspaceId));
    if (resource === 'members' && request.method === 'GET') return respond(access.members(user.id, workspaceId), members => ({ members }));
    if (resource === 'disruptions' && request.method === 'POST') return bodyWith(request, disruptionSchema, async input => json(await monitoring.simulate(workspaceId, input.portId, input.delayHours)));
    if (resource === 'invitations' && request.method === 'POST') return bodyWith(request, z.object({ email }), async input => {
      const invitation = access.invite(user.id, workspaceId, input.email);
      if (!invitation.ok) return respond(invitation);
      const inviteUrl = `${origin}/?invite=${encodeURIComponent(invitation.value.token)}`;
      if (!mail) return json({ email: invitation.value.email, url: inviteUrl, delivery: 'link-only' });
      const sent = await mailTransport(new Request('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${mail.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': invitation.value.id },
        body: JSON.stringify({ from: mail.from, to: [invitation.value.email], subject: 'Join your Gazetteer workspace', text: `${user.name} invited you to ${membership.value.name} on Gazetteer.\n\nSign in with ${invitation.value.email} and accept your invitation:\n${inviteUrl}\n\nThis link expires in seven days. Shipment information is synthetic demo data.` }),
        signal: AbortSignal.timeout(10000),
      })).catch(() => null);
      const receipt = sent?.ok ? mailReceiptSchema.safeParse(await sent.json().catch(() => null)) : undefined;
      const delivery: InvitationDelivery = receipt?.success
        ? { delivery: 'accepted', messageId: receipt.data.id }
        : { delivery: 'unconfirmed', warning: 'Email delivery is unconfirmed. Share this invitation link directly.' };
      return json({ email: invitation.value.email, url: inviteUrl, ...delivery });
    });
    const shipmentId = match[3];
    if (shipmentId) {
      const dashboard = await monitoring.dashboard(workspaceId);
      if (!dashboard.shipments.some(shipment => shipment.id === shipmentId)) return json({ error: 'Shipment not found' }, 404);
      if (request.method === 'GET') return respond(access.comments(user.id, workspaceId, shipmentId), comments => ({ comments }));
      return bodyWith(request, z.object({ body: z.string().trim().min(1).max(4000) }), input => {
        const added = access.comment(user.id, workspaceId, shipmentId, input.body);
        return added.ok ? respond(access.comments(user.id, workspaceId, shipmentId), comments => ({ comments })) : respond(added);
      });
    }
    return json({ error: 'Method not allowed' }, 405);
  };
}
