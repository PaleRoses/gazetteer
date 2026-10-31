import type { BoardMessage, PortStatus } from './board.js';
export type Risk = 'on-track' | 'watch' | 'delayed';
export type RelayOutcome<A> = Readonly<{ status: 'ok'; value: A }> | Readonly<{ status: 'unavailable'; message: string }>;
export const relaySuccess = <A>(value: A): RelayOutcome<A> => ({ status: 'ok', value });
export type PortId = 'singapore' | 'rotterdam' | 'shanghai' | 'los-angeles' | 'jebel-ali';
export type Port = Readonly<{ id: PortId; name: string; country: string; coordinates: readonly [number, number] }>;
type EvidenceBody = Readonly<{ id: string; title: string; detail: string; observedAt: string }>;
export type ReportContext = Readonly<{ kind: 'news' | 'advisory'; region: string; reviewedAt: string; validUntil?: string }>;
export type Evidence = EvidenceBody & (Readonly<{ source: 'simulation' }> | Readonly<{ source: 'live'; provider: string; url: string; report?: ReportContext }>);
export type Milestone = Readonly<{ label: string; at: string; status: 'complete' | 'current' | 'upcoming' }>;
export type Shipment = Readonly<{
  id: string; vessel: string; reference: string; cargo: string; containers: number;
  origin: PortId; destination: PortId; via: readonly PortId[];
  coordinates: readonly [number, number]; route: readonly (readonly [number, number])[];
  baselineEta: string; eta: string; risk: Risk; delayHours: number;
  change: string; action: string | null; milestones: readonly Milestone[];
  evidence: readonly Evidence[]; appliedDisruptions: readonly string[];
  assessments?: readonly AssessmentRecord[];
}>;
/** `delayHours` is null for a live notice: no feed states a delay, so the assessor decides. `geometry` is the notice's reach as a circle. */
export type Disruption = Readonly<{ id: string; portId: PortId; scope?: 'port' | 'lane'; delayHours: number | null; evidence: Evidence; geometry?: Readonly<{ center: readonly [number, number]; radiusKm: number }> }>;
export type Workspace = Readonly<{ id: string; name: string; role: 'owner' | 'member' }>;
export type User = Readonly<{ id: string; name: string; email: string }>;
export type Comment = Readonly<{ id: string; author: string; body: string; createdAt: string }>;
export type Dashboard = Readonly<{
  intelligence?: Intelligence;
  routes?: readonly MonitoredRoute[];
  shipments: readonly Shipment[]; ports: readonly Port[]; updatedAt: string;
  /** 'mixed' = live notices may appear beside simulated ones, each labelled by its evidence. */
  mode: 'simulation' | 'mixed'; runtime: string; relay: string;
  portStatus?: readonly PortStatus[]; board?: readonly BoardMessage[];
  /** Present only while the workspace's actors are still starting; the shipments shown for the rest are their seed state. `queued` counts simulated disruptions waiting for their port actor. */
  startup?: Readonly<{ ready: number; total: number; queued?: number }>;
}>;

/** Assessment provenance travels with the shipment; the client never invents a risk score. */
export type AssessmentRecord = Readonly<{
  noticeId: string; basis?: 'port-notice' | 'live-telemetry'; method: 'ai-assessed' | 'deterministic-fallback'; model: string | null; assessedAt: string; affected: boolean;
  delayHours: Readonly<{ low: number; likely: number; high: number }>; confidence: number | null;
  rationale: string; citedEvidence: readonly string[]; fallbackReason: string | null;
}>;
export type Diversion = Readonly<{
  id: string; shipmentId: string; name: string; replaces: PortId; coordinates: readonly [number, number];
  reason: string; constraint: string;
}>;
export type NewsRelevance = Readonly<{ shipmentId: string; kind: 'route' | 'diversion' | 'context'; reason: string; diversionId?: string }>;
export type IntelligenceItem = Readonly<{
  evidence: Evidence; coordinates: readonly [number, number] | null;
  relevance: readonly NewsRelevance[];
}>;
export type Intelligence = Readonly<{
  items: readonly IntelligenceItem[]; diversions: readonly Diversion[];
  checkedAt: string; unavailableProviders: readonly string[]; sourcesEnabled: boolean;
}>;

/** A two-way port-to-port monitoring corridor, not a carrier service or prescribed navigation lane. */
export type MonitoredRoute = Readonly<{
  id: string; endpoints: readonly [PortId, PortId]; path: readonly (readonly [number, number])[];
  shipmentIds: readonly string[]; risk: Risk; attention: number; maxDelayHours: number; summary: string;
  intelligence?: Intelligence;
}>;
