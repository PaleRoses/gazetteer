import { createActorStub, type ActorRpcMethod, type createActorTransport } from 'durable-actors/backend';
import type { BoardMessage } from '../../core/board';
import type { PortId } from '../../core/ports';
import { recoveryMessage, type RecoveryMessage } from '../../core/recovery';
import type { RecoveryCase, RecoveryView } from '../../core/reservations';
import { act2Anchor, reeferCommitments, trucksFor } from '../../core/services';
import { relaySuccess, type Disruption, type RelayOutcome, type Shipment } from '../../core/types';
import type { CargoAgent } from '../agents/cargo/agent';
import type { TerminalDesk } from '../agents/city/terminal-desk';
import { ledgerAt, type Bookings } from '../booking/ledger';
import type { Inbox } from '../relay/inbox';
import type { Outgoing, Transmitted } from '../relay/outbox';
import { createDelivery } from './delivery';
import { createCoalescer } from './coalesce';
import { haulierStub, type HaulierClient } from './recovery-haulier';
import { createStartup, type Startup, type StartupTask } from './startup';

/** Act 2's runtime: the cargo agent, Rotterdam's terminal desk and its haulier, started beside act 1's actors and routed the recovery.* messages they answer. */
type Common = Pick<CargoAgent, 'join' | 'check' | 'resume' | 'deliver' | 'unpublished' | 'acknowledge'>;
export type CargoClient = Common & Pick<CargoAgent, 'initialize' | 'snapshot'>;
export type TerminalClient = Common & Pick<TerminalDesk, 'initialize'>;
export type Clients = Readonly<{
  cargo: (workspaceId: string, shipmentId: string) => CargoClient;
  terminal: (workspaceId: string, city: PortId) => TerminalClient;
  haulier: (workspaceId: string, city: PortId) => HaulierClient;
}>;

const common = [{ name: 'join', result: 'value' }, { name: 'check', result: 'value' }, { name: 'resume', result: 'void' }, { name: 'deliver', result: 'void' }, { name: 'unpublished', result: 'value' }, { name: 'acknowledge', result: 'void' }] as const;
const cargoMethods = [{ name: 'initialize', result: 'value' }, { name: 'snapshot', result: 'value' }, ...common] satisfies readonly (ActorRpcMethod & { name: keyof CargoClient })[];
const terminalMethods = [{ name: 'initialize', result: 'value' }, ...common] satisfies readonly (ActorRpcMethod & { name: keyof TerminalClient })[];

export const actorClients = (transport: ReturnType<typeof createActorTransport>): Clients => ({
  cargo: (workspaceId, shipmentId) => createActorStub<CargoClient>('CargoAgent', `${workspaceId}-cargo-${shipmentId}`, cargoMethods, transport),
  terminal: (workspaceId, city) => createActorStub<TerminalClient>('TerminalDesk', `${workspaceId}-city-${city}-terminal`, terminalMethods, transport),
  haulier: (workspaceId, city) => haulierStub(workspaceId, city, transport),
});

type Role = 'cargo' | 'terminal' | 'haulier';
type Target = Readonly<{ role: Role; city?: PortId }>;

/**
 * Who a recovery message is for: a request goes to the provider it names; an offer or a withdrawal to the case's cargo agent; a hold, confirm or
 * release to the provider of the offer it acts on (the offer id says whose: `<city>:truck:...` is the haulier's, anything else the terminal's).
 */
export const targetsOf = (message: BoardMessage): readonly Target[] => {
  const parsed = recoveryMessage.safeParse(message);
  if (!parsed.success) return [];
  const recovery: RecoveryMessage = parsed.data;
  switch (recovery.kind) {
    case 'recovery.request': return [{ role: recovery.to.role === 'haulier' ? 'haulier' : 'terminal', city: recovery.to.city }];
    case 'recovery.offer': case 'recovery.withdraw': return [{ role: 'cargo' }];
    case 'recovery.hold': case 'recovery.confirm': case 'recovery.release': {
      const [city, service] = recovery.offerId.split(':');
      return [{ role: service === 'truck' ? 'haulier' : 'terminal', ...(city ? { city: city as PortId } : {}) }];
    }
    case 'recovery.plan': return [];
  }
};

type Member = Readonly<{ key: string; role: Role; city: PortId; client: Common; initialize: () => Promise<RelayOutcome<null>> }>;

export type RecoveryDeps = Readonly<{
  clients: Clients; workspaceKey: string; bookingsPath: string;
  /** The ship whose cargo act 2 is about, read from its actor (persisted truth): the anchor must not move when the server restarts. */
  meridianStar: (workspaceId: string) => Promise<Pick<Shipment, 'id' | 'vessel' | 'baselineEta'> | null>;
  limit: <A>(operation: () => Promise<A>) => Promise<A>;
  /** Writes an actor's unacknowledged posts to Relay on the shared slots and notes the outcome for the relay health; the actor is acknowledged by the caller. */
  send: (outgoing: Outgoing<Disruption>) => Promise<Transmitted>;
  /** Echoes posts into the read model and every ready actor's inbox; returns how many were new. */
  absorb: (workspaceId: string, batch: Inbox) => Promise<number>;
  announce: (workspaceId: string) => void;
  ledger?: Pick<Bookings, 'list'>;
  delaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void>;
}>;

export type Recovery = Readonly<{
  /** Starts the act 2 actors for a workspace in the background; free after the first call. */
  begin(workspaceId: string): void;
  /** The recovery messages the server heard or authored, routed to the actors they are for. */
  deliver(workspaceId: string, batch: Inbox): Promise<void>;
  /** Lets each ready actor decide and say what it has to say; returns how many posts were new, so the caller can go another round. */
  step(workspaceId: string): Promise<number>;
  /** The read model: the case as last reported and the ledger's reservations. No actor call. Undefined before act 2 has started. */
  view(workspaceId: string): RecoveryView | undefined;
  /** The demo's "Withdraw truck": the haulier withdraws the offer that leaves last, with its bookings. */
  withdrawTruck(workspaceId: string): Promise<RelayOutcome<string | null>>;
  /** The demo's "Restart cargo agent": it drops what it held in memory and resumes from its persisted case, re-reading the board and the ledger. */
  restartCargo(workspaceId: string): Promise<RelayOutcome<null>>;
  close(): void;
}>;

const reason = 'Simulated: the truck was withdrawn by the demo control.';
const unavailable = (message: string): RelayOutcome<never> => ({ status: 'unavailable', message });

export function createRecovery(deps: RecoveryDeps): Recovery {
  const { clients, limit } = deps;
  const ledger = deps.ledger ?? ledgerAt(deps.bookingsPath);
  const cargoKey = 'cargo';
  const terminalKey = (city: PortId): string => `terminal:${city}`;
  const haulierKey = (city: PortId): string => `haulier:${city}`;
  const city: PortId = 'rotterdam';
  const members = new Map<string, readonly Member[]>();
  const cases = new Map<string, RecoveryCase | null>();
  const begun = new Set<string>();
  const delivery = createDelivery();
  let closed = false;

  /** The case needs the ship's persisted anchor; an actor that is not up yet makes the task retry. */
  const membersOf = (workspaceId: string): readonly Member[] => members.get(workspaceId) ?? [];
  const bringUp = (workspaceId: string): readonly Member[] => {
    const known = members.get(workspaceId);
    if (known) return known;
    const cargo = clients.cargo(workspaceId, 'gz-1042');
    const desk = clients.terminal(workspaceId, city);
    const haul = clients.haulier(workspaceId, city);
    const anchored = async <A>(use: (ship: Pick<Shipment, 'id' | 'vessel' | 'baselineEta'>, anchor: string) => Promise<RelayOutcome<A>>): Promise<RelayOutcome<A>> => {
      const ship = await deps.meridianStar(workspaceId);
      return ship ? use(ship, act2Anchor(ship)) : unavailable('The ship is not ready, so act 2 has no anchor yet.');
    };
    const built: readonly Member[] = [
      { key: terminalKey(city), role: 'terminal', city, client: desk, initialize: () => anchored((_, anchor) => desk.initialize(workspaceId, city, deps.workspaceKey, false, deps.bookingsPath, anchor)) },
      { key: haulierKey(city), role: 'haulier', city, client: haul, initialize: () => anchored((_, anchor) => haul.initialize(workspaceId, city, deps.workspaceKey, false, deps.bookingsPath, trucksFor(city, anchor))) },
      {
        key: cargoKey, role: 'cargo', city, client: cargo,
        initialize: () => anchored((ship, anchor) => {
          const commitments = reeferCommitments(anchor);
          return cargo.initialize(workspaceId, deps.workspaceKey, deps.bookingsPath, `case:${ship.id}:${commitments.container}`, ship.vessel, commitments);
        }),
      },
    ];
    members.set(workspaceId, built);
    return built;
  };

  const startup: Startup = createStartup({
    limit,
    tasksOf: workspaceId => bringUp(workspaceId).map((member): StartupTask => ({
      key: member.key, run: async () => (await member.initialize()).status === 'ok',
      follow: async () => (await member.client.join(workspaceId, deps.workspaceKey, false)).status === 'ok',
    })),
    onReady: (workspaceId, key) => {
      void membersOf(workspaceId).find(member => member.key === key)?.client.resume().catch(() => undefined);
      void deliverTo(workspaceId, key);
      deps.announce(workspaceId);
    },
    ...(deps.delaysMs ? { delaysMs: deps.delaysMs } : {}), ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });

  const isFor = (member: Member, target: Target): boolean => member.role === target.role && (member.role === 'cargo' || target.city === undefined || member.city === target.city);
  const forMember = (member: Member, batch: Inbox): Inbox => ({ board: batch.board.filter(message => targetsOf(message).some(target => isFor(member, target))), disruptions: [] });
  const deliverTo = (workspaceId: string, key: string): Promise<void> => {
    const member = membersOf(workspaceId).find(item => item.key === key);
    return member ? delivery.deliver(workspaceId, key, batch => member.client.deliver(forMember(member, batch)), batch => forMember(member, batch).board.length > 0) : Promise.resolve();
  };

  /** Writing to Relay is background work on the shared slots: an actor awaiting Relay would hold its own queue. What fails stays in its durable outbox. */
  const publish = createCoalescer(async key => {
    const [workspaceId, memberKey] = key.split('\u0000') as [string, string];
    const member = membersOf(workspaceId).find(item => item.key === memberKey);
    const outgoing = await member?.client.unpublished();
    if (!member || !outgoing || outgoing.board.length === 0) return;
    const sent = await deps.send(outgoing);
    await member.client.acknowledge({ board: sent.board, disruptions: sent.disruptions });
  });
  const captureCase = createCoalescer(async workspaceId => {
    const snapshot = await clients.cargo(workspaceId, 'gz-1042').snapshot();
    if (!snapshot) return;
    cases.set(workspaceId, { caseId: snapshot.caseId, method: snapshot.method, plan: snapshot.plan, delivered: snapshot.delivered });
    deps.announce(workspaceId);
  }, error => { if (!closed) console.error('Recovery case capture failed:', error instanceof Error ? error.message : 'unknown error'); });

  const stepMember = async (workspaceId: string, member: Member): Promise<number> => {
    await member.client.check().catch(() => undefined);
    const outgoing = await member.client.unpublished().catch(() => null);
    const echoed = await deps.absorb(workspaceId, { board: outgoing?.board ?? [], disruptions: [] });
    void publish(`${workspaceId}\u0000${member.key}`);
    if (member.role === 'cargo') void captureCase(workspaceId);
    return echoed;
  };

  return {
    begin: workspaceId => { begun.add(workspaceId); startup.ensure(workspaceId); },
    deliver: async (workspaceId, batch) => {
      const routed = batch.board.filter(message => targetsOf(message).length > 0);
      if (routed.length === 0) return;
      delivery.record(workspaceId, { board: routed, disruptions: [] });
      await Promise.all(membersOf(workspaceId).filter(member => startup.isReady(workspaceId, member.key)).map(member => deliverTo(workspaceId, member.key)));
    },
    step: async workspaceId => {
      const ready = membersOf(workspaceId).filter(member => startup.isReady(workspaceId, member.key));
      const counts = await Promise.all(ready.map(member => stepMember(workspaceId, member)));
      return counts.reduce((total, count) => total + count, 0);
    },
    view: workspaceId => begun.has(workspaceId) ? { case: cases.get(workspaceId) ?? null, reservations: ledger.list(workspaceId) } : undefined,
    withdrawTruck: async workspaceId => {
      const member = membersOf(workspaceId).find(item => item.key === haulierKey(city));
      if (!member || !startup.isReady(workspaceId, member.key)) return unavailable('The haulier is not ready yet.');
      const withdrawn = await clients.haulier(workspaceId, city).withdraw(reason, null);
      await stepMember(workspaceId, member);
      return withdrawn;
    },
    restartCargo: async workspaceId => {
      const member = membersOf(workspaceId).find(item => item.key === cargoKey);
      if (!member || !startup.isReady(workspaceId, member.key)) return unavailable('The cargo agent is not ready yet.');
      await member.client.resume();
      await stepMember(workspaceId, member);
      return relaySuccess(null);
    },
    close: () => { closed = true; startup.close(); delivery.close(); },
  };
}
