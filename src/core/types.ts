import type { BoardMessage, PortStatus } from './board.js';
import type { PortId } from './ports.js';
import type { RecoveryView } from './reservations.js';
export type Risk = 'on-track' | 'watch' | 'delayed';
export type RelayOutcome<A> = Readonly<{ status: 'ok'; value: A }> | Readonly<{ status: 'unavailable'; message: string }>;
export const relaySuccess = <A>(value: A): RelayOutcome<A> => ({ status: 'ok', value });
type Port = Readonly<{ id: PortId; name: string; country: string; coordinates: readonly [number, number] }>;
type EvidenceBody = Readonly<{ id: string; title: string; detail: string; observedAt: string }>;
export type Evidence = EvidenceBody & (Readonly<{ source: 'simulation' }> | Readonly<{ source: 'live'; provider: string; url: string }>);
type Milestone = Readonly<{ label: string; at: string; status: 'complete' | 'current' | 'upcoming' }>;
export type Shipment = Readonly<{
  id: string; vessel: string; /** The mind aboard: named once, from the ship's place in the fleet, and never renamed. */ agent: string; reference: string; cargo: string; containers: number;
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
  /** Present only while the workspace's actors are still starting; the shipments shown for the rest are their seed state. `queued` counts simulated disruptions waiting for their port actor. */
  startup?: Readonly<{ ready: number; total: number; queued?: number }>;
  /** The board transport, as data: `reconnecting` since T while posts fail, `live` with the last acknowledged post at T. Never a status code. */
  relayHealth?: Readonly<{ state: 'live' | 'reconnecting'; since: string | null; lastPostAt: string | null }>;
  /** Act 2: the cargo agent's case and the workspace's reservations; absent until the recovery actors have started. */
  recovery?: RecoveryView;
}>;
