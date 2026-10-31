export type Risk = 'on-track' | 'watch' | 'delayed';
export type PortId = 'singapore' | 'rotterdam' | 'shanghai' | 'los-angeles';
export type Port = Readonly<{ id: PortId; name: string; country: string; coordinates: readonly [number, number] }>;
export type Evidence = Readonly<{ id: string; source: 'simulation'; title: string; detail: string; observedAt: string }>;
export type Milestone = Readonly<{ label: string; at: string; status: 'complete' | 'current' | 'upcoming' }>;
export type Shipment = Readonly<{
  id: string; vessel: string; reference: string; cargo: string; containers: number;
  origin: PortId; destination: PortId; via: readonly PortId[];
  coordinates: readonly [number, number]; route: readonly (readonly [number, number])[];
  baselineEta: string; eta: string; risk: Risk; delayHours: number;
  change: string; action: string | null; milestones: readonly Milestone[];
  evidence: readonly Evidence[]; appliedDisruptions: readonly string[];
}>;
export type Disruption = Readonly<{ id: string; portId: PortId; delayHours: number; evidence: Evidence }>;
export type Workspace = Readonly<{ id: string; name: string; role: 'owner' | 'member' }>;
export type User = Readonly<{ id: string; name: string; email: string }>;
export type Comment = Readonly<{ id: string; author: string; body: string; createdAt: string }>;
export type Dashboard = Readonly<{
  shipments: readonly Shipment[]; ports: readonly Port[]; updatedAt: string;
  mode: 'simulation'; runtime: string; relay: string;
}>;
