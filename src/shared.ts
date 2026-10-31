import type { BoardMessage, PortStatus } from './board';
export type Risk = 'on-track' | 'watch' | 'delayed';
export type RelayOutcome<A> = Readonly<{ status: 'ok'; value: A }> | Readonly<{ status: 'unavailable'; message: string }>;
export const relaySuccess = <A>(value: A): RelayOutcome<A> => ({ status: 'ok', value });
export type PortId = 'singapore' | 'rotterdam' | 'shanghai' | 'los-angeles';
export type Port = Readonly<{ id: PortId; name: string; country: string; coordinates: readonly [number, number] }>;
type EvidenceBody = Readonly<{ id: string; title: string; detail: string; observedAt: string }>;
export type Evidence = EvidenceBody & (Readonly<{ source: 'simulation' }> | Readonly<{ source: 'live'; provider: string; url: string }>);
export type Milestone = Readonly<{ label: string; at: string; status: 'complete' | 'current' | 'upcoming' }>;
export type Shipment = Readonly<{
  id: string; vessel: string; reference: string; cargo: string; containers: number;
  origin: PortId; destination: PortId; via: readonly PortId[];
  coordinates: readonly [number, number]; route: readonly (readonly [number, number])[];
  baselineEta: string; eta: string; risk: Risk; delayHours: number;
  change: string; action: string | null; milestones: readonly Milestone[];
  evidence: readonly Evidence[]; appliedDisruptions: readonly string[];
}>;
/** `delayHours` is null for a live notice: no feed states a delay, so the assessor decides. `geometry` is the notice's reach as a circle. */
export type Disruption = Readonly<{ id: string; portId: PortId; scope?: 'port' | 'lane'; delayHours: number | null; evidence: Evidence; geometry?: Readonly<{ center: readonly [number, number]; radiusKm: number }> }>;
export type Workspace = Readonly<{ id: string; name: string; role: 'owner' | 'member' }>;
export type User = Readonly<{ id: string; name: string; email: string }>;
export type Comment = Readonly<{ id: string; author: string; body: string; createdAt: string }>;
export type Dashboard = Readonly<{
  shipments: readonly Shipment[]; ports: readonly Port[]; updatedAt: string;
  /** 'mixed' = live notices may appear beside simulated ones, each labelled by its evidence. */
  mode: 'simulation' | 'mixed'; runtime: string; relay: string;
  portStatus?: readonly PortStatus[]; board?: readonly BoardMessage[];
}>;
