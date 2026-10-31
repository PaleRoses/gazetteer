import { z } from 'zod';
import { portIds } from './ports.js';

const portId = z.enum(portIds);
const instant = z.iso.datetime();
const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const risk = z.enum(['on-track', 'watch', 'delayed']);

export const portRisk = z.enum(['normal', 'elevated', 'severe']);
export const signalKind = z.enum(['off-route', 'slow-steaming', 'stationary-outside-port', 'ais-dark']);

export const author = z.discriminatedUnion('role', [
  z.object({ role: z.literal('port'), id: portId }),
  z.object({ role: z.literal('ship'), id: z.string().min(1), vessel: z.string().min(1) }),
]);

const envelope = { id: z.string().min(1), author, at: instant, summary: z.string().min(1).max(280) };

export const portBulletin = z.object({
  ...envelope,
  kind: z.literal('port.bulletin'),
  portId,
  risk: portRisk,
  anchored: z.number().int().nonnegative(),
  arrivals48h: z.number().int().nonnegative(),
  evidenceIds: z.array(z.string()),
});

export const shipObservation = z.object({
  ...envelope,
  kind: z.literal('ship.observation'),
  shipmentId: z.string().min(1),
  signals: z.array(signalKind).min(1),
  position,
  nearPort: portId.nullable(),
  provider: z.string().min(1),
  observedAt: instant,
});

export const shipAssessment = z.object({
  ...envelope,
  kind: z.literal('ship.assessment'),
  shipmentId: z.string().min(1),
  risk,
  eta: instant,
  delayHours: z.object({ low: z.number(), likely: z.number(), high: z.number() }).nullable(),
  confidence: z.number().min(0).max(1),
  method: z.enum(['ai-assessed', 'deterministic-fallback', 'deterministic']),
  citedEvidence: z.array(z.string()),
  ports: z.array(portId),
});

export const etaNotice = z.object({
  ...envelope,
  kind: z.literal('ship.eta'),
  shipmentId: z.string().min(1),
  portId,
  eta: instant,
  previousEta: instant,
});

export const boardMessage = z.discriminatedUnion('kind', [portBulletin, shipObservation, shipAssessment, etaNotice]);

export type PortRisk = z.infer<typeof portRisk>;
export type BoardAuthor = z.infer<typeof author>;
export type PortBulletin = z.infer<typeof portBulletin>;
export type ShipObservation = z.infer<typeof shipObservation>;
export type ShipAssessment = z.infer<typeof shipAssessment>;
export type EtaNotice = z.infer<typeof etaNotice>;
export type BoardMessage = z.infer<typeof boardMessage>;
export type BoardKind = BoardMessage['kind'];

export const boardMetadataKind = 'gazetteer.board';

export const parseBoardMessage = (value: unknown): BoardMessage | undefined => {
  const parsed = boardMessage.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

export const concerns = (message: BoardMessage): Readonly<{ ports: readonly z.infer<typeof portId>[]; shipmentId: string | null }> => {
  switch (message.kind) {
    case 'port.bulletin': return { ports: [message.portId], shipmentId: null };
    case 'ship.observation': return { ports: message.nearPort ? [message.nearPort] : [], shipmentId: message.shipmentId };
    case 'ship.assessment': return { ports: message.ports, shipmentId: message.shipmentId };
    case 'ship.eta': return { ports: [message.portId], shipmentId: message.shipmentId };
  }
};

export const portStatus = z.object({
  portId,
  risk: portRisk,
  relevance: z.number().int().nonnegative(),
  bulletin: portBulletin.nullable(),
});
export type PortStatus = z.infer<typeof portStatus>;
