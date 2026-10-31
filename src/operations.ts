import { z } from 'zod';

const port = z.enum(['singapore', 'rotterdam', 'shanghai', 'los-angeles', 'jebel-ali']);
export const validImo = (value: string): boolean => /^\d{7}$/.test(value) && [...value.slice(0, 6)].reduce((sum, digit, i) => sum + Number(digit) * (7 - i), 0) % 10 === Number(value[6]);
export const identitySchema = z.object({
  imo: z.string().refine(value => !value || validImo(value), 'Enter a seven-digit IMO with a valid check digit.'),
  mmsi: z.string().refine(value => !value || /^[2-7]\d{8}$/.test(value), 'Enter a nine-digit ship MMSI.'),
});
export const voyageSchema = z.object({
  departure: z.string().datetime(), eta: z.string().datetime(),
  status: z.enum(['planned', 'underway', 'stopped', 'arrived']),
  updatedAt: z.string().datetime(), updatedBy: z.string(), statusSince: z.string().datetime(),
  source: z.literal('operator'),
});
export const vesselInputSchema = z.object({
  id: z.string().min(1).max(80).optional(), vessel: z.string().trim().min(1).max(100),
  identity: identitySchema, origin: port, destination: port, via: z.array(port).max(3),
  departure: z.string().datetime(), eta: z.string().datetime(), status: voyageSchema.shape.status,
}).superRefine((value, ctx) => {
  const problem = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!value.id && !value.identity.imo && !value.identity.mmsi) problem('An IMO or MMSI is required to add a vessel.');
  if (new Set([value.origin, ...value.via, value.destination]).size !== value.via.length + 2) problem('Each port in a voyage must be different.');
  if (Date.parse(value.eta) <= Date.parse(value.departure)) problem('ETA must be after departure.');
});
export const alertPreferencesSchema = z.object({ etaHours: z.number().min(0.25).max(168), stopHours: z.number().min(0.25).max(168), staleHours: z.number().min(0.25).max(168) });
export const defaultAlertPreferences = { etaHours: 6, stopHours: 6, staleHours: 6 };
export const alertSchema = z.object({
  id: z.string(), shipmentId: z.string(), vessel: z.string(),
  kind: z.enum(['eta', 'departure', 'arrival', 'stop', 'stale']), title: z.string(), detail: z.string(),
  source: z.enum(['operator', 'simulation', 'live']), createdAt: z.string(), acknowledgedAt: z.string().nullable(),
});
export const operationsSchema = z.object({ alerts: z.array(alertSchema), preferences: alertPreferencesSchema });
export const operationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save'), vessel: vesselInputSchema }),
  z.object({ action: z.literal('remove'), id: z.string().min(1).max(80) }),
  z.object({ action: z.literal('acknowledge'), id: z.string().min(1).max(200) }),
  z.object({ action: z.literal('preferences'), preferences: alertPreferencesSchema }),
]);
export type VesselInput = z.infer<typeof vesselInputSchema>;
export type Voyage = z.infer<typeof voyageSchema>;
export type VesselIdentity = z.infer<typeof identitySchema>;
export type Operations = z.infer<typeof operationsSchema>;
export type FleetAlert = z.infer<typeof alertSchema>;
export type Operation = z.infer<typeof operationSchema>;
