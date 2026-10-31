import { operationSchema } from '../../core/operations';
import { OperationsError } from '../runtime/operations';
import { zValidator } from '@hono/zod-validator';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { createEventsHandler } from './events';
import { createIngestHandler, createVesselsHandler, type IngestFeed } from './ingest';
import type { Bookings } from '../booking/ledger';
import type { Access, AccessError, Result, Session } from '../access/access';
import type { Monitoring } from '../runtime/monitoring';
import { portIds } from '../../core/ports';
import type { Dashboard, RelayOutcome, User, Workspace } from '../../core/types';
type Mail = Readonly<{ key: string; from: string }>;
type MailTransport = (request: Request) => Promise<Response>;
type InvitationDelivery = Readonly<{ delivery: 'accepted'; messageId: string }>
  | Readonly<{ delivery: 'unconfirmed'; warning: string }>;
type Options = Readonly<{ access: Access; monitoring: Pick<Monitoring, 'dashboard' | 'simulate'> & Partial<Pick<Monitoring, 'subscribe' | 'publishComment' | 'ask' | 'operate' | 'delayMeridianStar' | 'withdrawTruck' | 'restartCargo'>>; origin: string; ingest?: IngestFeed; bookings?: Pick<Bookings, 'list'>; demo?: DemoAccess; mail?: Mail; mailTransport?: MailTransport }>;
type App = Readonly<{ Bindings: Readonly<{ clientKey: string }>; Variables: Readonly<{ user: User; token: string | undefined; membership: Workspace }> }>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => Response.json(body, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
});
const accessStatus: Record<AccessError, number> = {
  invalid_input: 400, email_in_use: 409, invalid_credentials: 401, unauthenticated: 401,
  forbidden: 403, not_found: 404, invalid_invitation: 400, already_member: 409,
};
const respond = <T>(result: Result<T>, project: (value: T) => unknown = value => value): Response =>
  result.ok ? json(project(result.value)) : json({ error: result.error.replaceAll('_', ' ') }, accessStatus[result.error]);
const monitoringResponse = (outcome: RelayOutcome<Dashboard>): Response =>
  outcome.status === 'ok' ? json(outcome.value) : json({ error: outcome.message }, 503);
const tokenFrom = (request: Request): string | undefined => request.headers.get('Cookie')?.split(';').map(value => value.trim()).find(value => value.startsWith('gazetteer_session='))?.slice('gazetteer_session='.length);
const email = z.string().trim().email().max(254);
const password = z.string().min(12).max(1024);
const signupSchema = z.object({ email, password, name: z.string().trim().min(1).max(80), workspaceName: z.string().trim().min(1).max(100).optional() });
const loginSchema = z.object({ email, password: z.string().max(1024) });
const disruptionSchema = z.object({ portId: z.enum(portIds), delayHours: z.number().int().min(1).max(168) });
const mailReceiptSchema = z.object({ id: z.string().trim().min(1) });

/** A body is JSON or it is refused before it is read; a JSON body that fails its schema is one answer, whatever the failure. */
const jsonOnly: MiddlewareHandler<App> = (c, next) =>
  c.req.header('Content-Type')?.startsWith('application/json') ? next() : Promise.resolve(json({ error: 'Expected application/json' }, 415));
const body = <S extends z.ZodType>(schema: S) => zValidator('json', schema, result => result.success ? undefined : json({ error: 'Invalid request fields' }, 400));

const loopbackHosts: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
type DemoAccess = 'off' | 'loopback' | 'public';
const demoAccess = (setting: string | undefined): DemoAccess => setting === 'off' || setting === 'public' ? setting : 'loopback';
const demoOperator = { email: 'demo@gazetteer.local', name: 'Demo operator', workspaceName: 'Demo fleet' } as const;
const tooMany = (): Response => json({ error: 'Too many sign-in attempts. Try again in a minute.' }, 429, { 'Retry-After': '60' });
const workspaceResources = ['operations', 'dashboard', 'events', 'disruptions', 'members', 'invitations', 'bookings', 'delay-meridian-star', 'withdraw-truck', 'restart-cargo'] as const;
/** Ids are matched as written in the URL, never percent-decoded: `gz%2D1042` is not `gz-1042`. Segments: '', api, workspaces, <workspace>, shipments, <shipment>, comments. */
const segment = (c: Context, index: number): string => new URL(c.req.url).pathname.split('/')[index] ?? '';
const workspaceOf = (c: Context): string => segment(c, 3);
const shipmentOf = (c: Context): string => segment(c, 5);

export function createApi({ access, monitoring, origin, ingest, bookings, demo = demoAccess(process.env.GAZETTEER_DEMO), mail, mailTransport = fetch }: Options): (request: Request, clientKey?: string) => Promise<Response> {
  const cookie = (token: string, maxAge = 604800): string => `gazetteer_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`;
  const authenticated = (result: Result<Session>): Response => {
    if (!result.ok) return respond(result);
    const workspaces = access.workspaces(result.value.user.id);
    return workspaces.ok ? json({ user: result.value.user, workspaces: workspaces.value }, 200, { 'Set-Cookie': cookie(result.value.token) }) : respond(workspaces);
  };

  /** Waive-through sign-in: on a loopback origin by default, on any origin only when GAZETTEER_DEMO=public, never when GAZETTEER_DEMO=off. */
  const demoAvailable = demo === 'public' || (demo === 'loopback' && loopbackHosts.has(new URL(origin).hostname));
  /** A POST comes from the configured origin, or from this machine itself (the server is also reached on localhost behind a public tunnel). */
  const allowedOrigin = (from: string | undefined): boolean => from === origin || (from !== undefined && URL.canParse(from) && loopbackHosts.has(new URL(from).hostname));

  const events = monitoring.subscribe && createEventsHandler({
    subscribe: monitoring.subscribe,
    snapshot: async workspaceId => { const outcome = await monitoring.dashboard(workspaceId); return outcome.status === 'ok' ? outcome.value : null; },
  });

  const throttled: MiddlewareHandler<App> = (c, next) => access.allowAuth(c.env.clientKey) ? next() : Promise.resolve(tooMany());
  const signedIn: MiddlewareHandler<App> = (c, next) => {
    const token = tokenFrom(c.req.raw);
    const session = access.session(token);
    if (!session.ok) return Promise.resolve(respond(session));
    c.set('user', session.value);
    c.set('token', token);
    return next();
  };
  const member: MiddlewareHandler<App> = (c, next) => {
    const membership = access.membership(c.get('user').id, workspaceOf(c));
    if (!membership.ok) return Promise.resolve(respond(membership));
    c.set('membership', membership.value);
    return next();
  };
  /** A shipment route answers only for the workspace's own fleet; an unknown id is not found before any actor is asked. */
  const inFleet = (missing: string): MiddlewareHandler<App> => async (c, next) => {
    const dashboard = await monitoring.dashboard(workspaceOf(c));
    if (dashboard.status === 'unavailable') return monitoringResponse(dashboard);
    return dashboard.value.shipments.some(shipment => shipment.id === shipmentOf(c)) ? next() : json({ error: missing }, 404);
  };

  const app = new Hono<App>()
    // Order is the contract: origin, then the public routes, then a session, then membership per route.
    .use('*', (c, next) => c.req.method === 'POST' && !allowedOrigin(c.req.header('Origin')) ? Promise.resolve(json({ error: 'Origin not allowed' }, 403)) : next())
    .get('/api/demo-session', () => json({ available: demoAvailable }))
    .post('/api/demo-session', async c => {
      if (!demoAvailable) return json({ error: 'Demo access is not enabled here.' }, 403);
      return access.allowAuth(c.env.clientKey) ? authenticated(await access.demoSession(demoOperator)) : tooMany();
    })
    .post('/api/signup', throttled, jsonOnly, body(signupSchema), async c => authenticated(await access.signup(c.req.valid('json'))))
    .post('/api/login', throttled, jsonOnly, body(loginSchema), async c => authenticated(await access.login(c.req.valid('json'))))
    .get('/api/ingest', createIngestHandler(() => ingest))
    .get('/api/ingest/vessels', createVesselsHandler(() => ingest))
    .use('*', signedIn)
    .get('/api/session', c => respond(access.workspaces(c.get('user').id), workspaces => ({ user: c.get('user'), workspaces })))
    .post('/api/logout', c => {
      access.logout(c.get('token') ?? '');
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) });
    })
    .post('/api/workspaces', jsonOnly, body(z.object({ name: z.string().trim().min(1).max(100) })), c => respond(access.createWorkspace(c.get('user').id, c.req.valid('json').name)))
    .post('/api/invitations/accept', jsonOnly, body(z.object({ token: z.string().min(1).max(128) })), c => respond(access.acceptInvite(c.get('user').id, c.req.valid('json').token)))
    .post('/api/workspaces/:workspaceId/operations', member, jsonOnly, body(operationSchema), async c => monitoring.operate ? monitoringResponse(await monitoring.operate(workspaceOf(c), c.req.valid('json'), c.get('user').name)) : json({ error: 'Fleet editing is unavailable.' }, 503))
    .get('/api/workspaces/:workspaceId/dashboard', member, async c => monitoringResponse(await monitoring.dashboard(workspaceOf(c))))
    .get('/api/workspaces/:workspaceId/events', member, c => events ? events(c.req.raw, workspaceOf(c)) : json({ error: 'Not found' }, 404))
    .get('/api/workspaces/:workspaceId/bookings', member, c => json({ bookings: bookings?.list(workspaceOf(c)) ?? [] }))
    .get('/api/workspaces/:workspaceId/members', member, c => respond(access.members(c.get('user').id, workspaceOf(c)), members => ({ members })))
    .post('/api/workspaces/:workspaceId/shipments/:shipmentId/ask', member, inFleet('Ship not found'), jsonOnly, body(z.object({ question: z.string().trim().min(1).max(500) })), async c => {
      if (!monitoring.ask) return json({ error: 'The ship mind is unavailable.' }, 503);
      const answer = await monitoring.ask(workspaceOf(c), shipmentOf(c), c.req.valid('json').question);
      return answer.status === 'answered' ? json({ answer: answer.answer, cited: answer.cited, mind: answer.mind, session: answer.session }) : json({ error: answer.message }, 503);
    })
    .post('/api/workspaces/:workspaceId/disruptions', member, jsonOnly, body(disruptionSchema), async c => {
      const input = c.req.valid('json');
      return monitoringResponse(await monitoring.simulate(workspaceOf(c), input.portId, input.delayHours));
    })
    .post('/api/workspaces/:workspaceId/delay-meridian-star', member, async c => monitoring.delayMeridianStar ? monitoringResponse(await monitoring.delayMeridianStar(workspaceOf(c))) : json({ error: 'Not found' }, 404))
    .post('/api/workspaces/:workspaceId/withdraw-truck', member, async c => monitoring.withdrawTruck ? monitoringResponse(await monitoring.withdrawTruck(workspaceOf(c))) : json({ error: 'Not found' }, 404))
    .post('/api/workspaces/:workspaceId/restart-cargo', member, async c => monitoring.restartCargo ? monitoringResponse(await monitoring.restartCargo(workspaceOf(c))) : json({ error: 'Not found' }, 404))
    .post('/api/workspaces/:workspaceId/invitations', member, jsonOnly, body(z.object({ email })), async c => {
      const user = c.get('user');
      const invitation = access.invite(user.id, workspaceOf(c), c.req.valid('json').email);
      if (!invitation.ok) return respond(invitation);
      const inviteUrl = `${origin}/?invite=${encodeURIComponent(invitation.value.token)}`;
      if (!mail) return json({ email: invitation.value.email, url: inviteUrl, delivery: 'link-only' });
      const sent = await mailTransport(new Request('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${mail.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': invitation.value.id },
        body: JSON.stringify({ from: mail.from, to: [invitation.value.email], subject: 'Join your Gazetteer workspace', text: `${user.name} invited you to ${c.get('membership').name} on Gazetteer.\n\nSign in with ${invitation.value.email} and accept your invitation:\n${inviteUrl}\n\nThis link expires in seven days. Shipment information is synthetic demo data.` }),
        signal: AbortSignal.timeout(10000),
      })).catch(() => null);
      const receipt = sent?.ok ? mailReceiptSchema.safeParse(await sent.json().catch(() => null)) : undefined;
      const delivery: InvitationDelivery = receipt?.success
        ? { delivery: 'accepted', messageId: receipt.data.id }
        : { delivery: 'unconfirmed', warning: 'Email delivery is unconfirmed. Share this invitation link directly.' };
      return json({ email: invitation.value.email, url: inviteUrl, ...delivery });
    })
    // A known workspace resource asked the wrong way is refused after membership, as an unknown one is not found before it.
    .on(['GET', 'POST'], '/api/workspaces/:workspaceId/shipments/:shipmentId/comments', member, inFleet('Shipment not found'))
    .get('/api/workspaces/:workspaceId/shipments/:shipmentId/comments', c => respond(access.comments(c.get('user').id, workspaceOf(c), shipmentOf(c)), comments => ({ comments })))
    .post('/api/workspaces/:workspaceId/shipments/:shipmentId/comments', jsonOnly, body(z.object({ body: z.string().trim().min(1).max(4000) })), c => {
      const [workspaceId, shipmentId] = [workspaceOf(c), shipmentOf(c)];
      const added = access.comment(c.get('user').id, workspaceId, shipmentId, c.req.valid('json').body);
      if (added.ok) monitoring.publishComment?.(workspaceId, shipmentId, added.value);
      return added.ok ? respond(access.comments(c.get('user').id, workspaceId, shipmentId), comments => ({ comments })) : respond(added);
    })
    .notFound(() => json({ error: 'Not found' }, 404))
    // A body that is not JSON at all is the validator's one throw; it answers like any invalid body. Anything else is not ours to hide.
    .onError(error => {
      if (error instanceof OperationsError) return json({ error: error.message }, 400);
      if (error instanceof HTTPException && error.status === 400) return json({ error: 'Invalid request fields' }, 400);
      throw error;
    });

  workspaceResources.forEach(resource => app.all(`/api/workspaces/:workspaceId/${resource}`, member, () => json({ error: 'Method not allowed' }, 405)));

  return async (request, clientKey = 'unknown') =>
    request.method === 'GET' || request.method === 'POST' ? app.fetch(request, { clientKey }) : json({ error: 'Method not allowed' }, 405);
}
