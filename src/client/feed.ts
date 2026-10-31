import { z } from 'zod';
import type { Comment, Dashboard } from '../shared';
import { commentSchema, dashboardSchema } from './api';

export type CommentEvent = Readonly<{ shipmentId: string; comment: Comment }>;
const commentEventSchema: z.ZodType<CommentEvent> = z.object({ shipmentId: z.string(), comment: commentSchema });

const parseJson = <T>(schema: z.ZodType<T>, data: unknown): T | undefined => {
  if (typeof data !== 'string') return undefined;
  try { const parsed = schema.safeParse(JSON.parse(data)); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
};
export const parseDashboardEvent = (data: unknown): Dashboard | undefined => parseJson(dashboardSchema, data);
export const parseCommentEvent = (data: unknown): CommentEvent | undefined => parseJson(commentEventSchema, data);

/** A snapshot never replaces a newer one; equal timestamps are accepted so a revision in the same second is not lost. */
export const isCurrent = (held: Dashboard | null, incoming: Dashboard): boolean => held === null || !(Date.parse(incoming.updatedAt) < Date.parse(held.updatedAt));

export const mergeComment = (comments: readonly Comment[], incoming: Comment): readonly Comment[] =>
  comments.some(comment => comment.id === incoming.id) ? comments : [...comments, incoming];

export type Change = Readonly<{ id: string; vessel: string; kind: 'eta' | 'risk' }>;

/** Shipments whose arrival estimate or risk moved between two snapshots. */
export const changesBetween = (before: Dashboard | null, after: Dashboard): readonly Change[] =>
  before === null ? [] : after.shipments.flatMap((shipment): readonly Change[] => {
    const prior = before.shipments.find(item => item.id === shipment.id);
    if (!prior) return [];
    return [
      ...(prior.eta !== shipment.eta ? [{ id: shipment.id, vessel: shipment.vessel, kind: 'eta' as const }] : []),
      ...(prior.risk !== shipment.risk ? [{ id: shipment.id, vessel: shipment.vessel, kind: 'risk' as const }] : []),
    ];
  });
