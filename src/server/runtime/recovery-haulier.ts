import { createActorStub, type createActorTransport, type ActorRpcMethod } from 'durable-actors/backend';
import { portIds, type PortId } from '../../core/ports';
import { trucksFor } from '../../core/services';
import type { RelayOutcome } from '../../core/types';
import type { HaulierAgent } from '../agents/haulier/agent';

/** The haulier half of act 2's runtime wiring: how to reach a city's HaulierAgent, bring it up with the world's trucks, and withdraw one. Pure over a client, so the runtime composes it and a test can drive it. */
export type HaulierClient = Pick<HaulierAgent, 'initialize' | 'withdraw' | 'check' | 'resume' | 'deliver' | 'unpublished' | 'acknowledge'>;

const haulierMethods = [
  { name: 'initialize', result: 'value' }, { name: 'withdraw', result: 'value' }, { name: 'check', result: 'value' }, { name: 'resume', result: 'void' },
  { name: 'deliver', result: 'void' }, { name: 'unpublished', result: 'value' }, { name: 'acknowledge', result: 'void' },
] satisfies readonly (ActorRpcMethod & { name: keyof HaulierClient })[];

/** One haulier per city per workspace, named beside the city's watches. */
export const haulierName = (workspaceId: string, city: PortId): string => `${workspaceId}-city-${city}-haulier`;
export const haulierKey = (city: PortId): string => `haulier:${city}`;

export const haulierStub = (workspaceId: string, city: PortId, transport: ReturnType<typeof createActorTransport>): HaulierClient =>
  createActorStub<HaulierClient>('HaulierAgent', haulierName(workspaceId, city), haulierMethods, transport);

/** The cities that have a haulier: those the world gives trucks. */
export const haulierCities = (anchor: string): readonly PortId[] => portIds.filter(city => trucksFor(city, anchor).length > 0);

/** Brings a city's haulier up with the world's departures counted from the act's anchor. Idempotent: an initialized haulier only refreshes its schedule. */
export const initializeHaulier = (client: Pick<HaulierClient, 'initialize'>, setup: Readonly<{
  workspaceId: string; city: PortId; workspaceKey: string; createChannel: boolean; bookingsPath: string; anchor: string;
}>): Promise<RelayOutcome<null>> =>
  client.initialize(setup.workspaceId, setup.city, setup.workspaceKey, setup.createChannel, setup.bookingsPath, trucksFor(setup.city, setup.anchor));

/** The demo's "Withdraw truck": the haulier withdraws the offer that leaves last, with every booking of it. The reason says it is simulated. */
export const withdrawLastTruck = (client: Pick<HaulierClient, 'withdraw'>): Promise<RelayOutcome<string | null>> =>
  client.withdraw('Simulated: the truck was withdrawn by the demo control.', null);
