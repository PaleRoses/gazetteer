import { z } from 'zod';
import type { Comment, Dashboard, Shipment, User, Workspace } from '../shared';

const coordinate = z.tuple([z.number(), z.number()]);
const portId = z.enum(['singapore', 'rotterdam', 'shanghai', 'los-angeles']);
export const evidenceSchema = z.discriminatedUnion('source', [
  z.object({ id: z.string(), source: z.literal('simulation'), title: z.string(), detail: z.string(), observedAt: z.string() }),
  z.object({ id: z.string(), source: z.literal('live'), provider: z.string(), url: z.string().url().refine(value => /^https?:/.test(value)), title: z.string(), detail: z.string(), observedAt: z.string() }),
]);
const shipment: z.ZodType<Shipment> = z.object({
  id: z.string(), vessel: z.string(), reference: z.string(), cargo: z.string(), containers: z.number(),
  origin: portId, destination: portId, via: z.array(portId), coordinates: coordinate, route: z.array(coordinate),
  baselineEta: z.string(), eta: z.string(), risk: z.enum(['on-track', 'watch', 'delayed']), delayHours: z.number(),
  change: z.string(), action: z.string().nullable(),
  milestones: z.array(z.object({ label: z.string(), at: z.string(), status: z.enum(['complete', 'current', 'upcoming']) })),
  evidence: z.array(evidenceSchema),
  assessments: z.array(z.object({
    noticeId: z.string(), basis: z.enum(['port-notice', 'live-telemetry']).optional(), method: z.enum(['ai-assessed', 'deterministic-fallback']), model: z.string().nullable(), assessedAt: z.string(), affected: z.boolean(),
    delayHours: z.object({ low: z.number(), likely: z.number(), high: z.number() }), confidence: z.number().nullable(),
    rationale: z.string(), citedEvidence: z.array(z.string()), fallbackReason: z.string().nullable(),
  })).optional(),
  appliedDisruptions: z.array(z.string()),
});
const intelligenceSchema = z.object({
  items: z.array(z.object({ evidence: evidenceSchema, coordinates: coordinate.nullable(), relevance: z.array(z.object({ shipmentId: z.string(), kind: z.enum(['route', 'diversion', 'context']), reason: z.string(), diversionId: z.string().optional() })) })),
  diversions: z.array(z.object({ id: z.string(), shipmentId: z.string(), name: z.string(), replaces: portId, coordinates: coordinate, reason: z.string(), constraint: z.string() })),
  checkedAt: z.string(), unavailableProviders: z.array(z.string()), sourcesEnabled: z.boolean(),
});
export const dashboardSchema: z.ZodType<Dashboard> = z.object({ intelligence: intelligenceSchema.optional(), shipments: z.array(shipment), ports: z.array(z.object({ id: portId, name: z.string(), country: z.string(), coordinates: coordinate })), updatedAt: z.string(), mode: z.enum(['simulation', 'mixed']), runtime: z.string(), relay: z.string() });
const userSchema: z.ZodType<User> = z.object({ id: z.string(), name: z.string(), email: z.string() });
export const workspaceSchema: z.ZodType<Workspace> = z.object({ id: z.string(), name: z.string(), role: z.enum(['owner', 'member']) });
export const sessionSchema = z.object({ user: userSchema, workspaces: z.array(workspaceSchema) });
export const commentSchema: z.ZodType<Comment> = z.object({ id: z.string(), author: z.string(), body: z.string(), createdAt: z.string() });
export const commentsSchema = z.object({ comments: z.array(commentSchema) });
const invitationLink = { email: z.string(), url: z.string() };
export const invitationSchema = z.discriminatedUnion('delivery', [
  z.object({ ...invitationLink, delivery: z.literal('link-only') }),
  z.object({ ...invitationLink, delivery: z.literal('accepted'), messageId: z.string().min(1) }),
  z.object({ ...invitationLink, delivery: z.literal('unconfirmed'), warning: z.string() }),
]);
export const membersSchema = z.object({ members: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.enum(['owner', 'member']) })) });
export type Session = z.infer<typeof sessionSchema>;
export type Member = z.infer<typeof membersSchema>['members'][number];
export type Invitation = z.infer<typeof invitationSchema>;
export type ApiResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: string; status: number }>;
export async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, signal?: AbortSignal): Promise<ApiResult<T>> {
  const deadline = AbortSignal.timeout(125_000);
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return fetch(path, { credentials: 'same-origin', signal: requestSignal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
    .then(async response => {
      const json: unknown = await response.json();
      if (!response.ok) {
        const error = z.object({ error: z.string() }).safeParse(json);
        return { ok: false as const, error: error.success ? error.data.error : 'The request could not be completed.', status: response.status };
      }
      const parsed = schema.safeParse(json);
      return parsed.success ? { ok: true as const, value: parsed.data } : { ok: false as const, error: 'The server returned an unexpected response. Please refresh.', status: 502 };
    })
    .catch((error: unknown) => ({ ok: false as const, error: deadline.aborted ? 'Request timed out; its outcome is unconfirmed. Refresh before trying again.' : error instanceof Error && error.name === 'AbortError' ? 'Request cancelled.' : 'Cannot reach the workspace. Check the server connection.', status: 0 }));
}
