import { describe, expect, test } from 'bun:test';
import { bookingKey, type RecoveryMessage } from '../src/core/recovery';
import { reeferCommitments, terminalQuote, trucksFor } from '../src/core/services';
import { createBookings, type Bookings } from '../src/server/booking/ledger';
import { cycle } from '../src/server/agents/cargo/cycle';
import { hear as cargoHears, openCase, reconcile, type CaseState } from '../src/server/agents/cargo/negotiate';
import { emptyTerminalMemory, hear as terminalHears, type TerminalMemory } from '../src/server/agents/city/terminal';
import { emptyHaulierMemory, hear as haulierHears, withdrawTruck, type HaulierMemory } from '../src/server/agents/haulier/decide';

/** Act 2 through the three agents' own decisions on the world's own numbers, no actors: Meridian Star's reefer, Rotterdam's terminal desk and haulier, one sandbox ledger. */
const anchor = '2026-11-13T09:00:00.000Z';
const now = '2026-11-13T07:00:00.000Z';
const at = (hours: number): string => new Date(Date.parse(anchor) + hours * 3_600_000).toISOString();
const workspaceId = 'ws-act2';
const caseId = 'case:gz-1042:MSTU4182651';

type World = Readonly<{ board: readonly RecoveryMessage[]; cargo: CaseState; haulier: HaulierMemory; terminal: TerminalMemory }>;

const society = (ledger: Bookings) => {
  const haulierContext = { city: 'rotterdam' as const, workspaceId, trucks: trucksFor('rotterdam', anchor), now, ledger };
  const terminalContext = { city: 'rotterdam' as const, workspaceId, now, ledger, quote: (ask: Parameters<typeof terminalQuote>[2]) => terminalQuote('rotterdam', anchor, ask, now) };
  const step = (world: World): World => {
    const said = cycle(reconcile(cargoHears(world.cargo, world.board), key => ledger.find(key)?.status), now);
    const afterCargo = [...world.board, ...said.messages];
    const hauled = haulierHears(haulierContext, world.haulier, afterCargo);
    const desked = terminalHears(terminalContext, world.terminal, afterCargo);
    return { board: [...afterCargo, ...hauled.posts, ...desked.posts], cargo: said.state, haulier: hauled.memory, terminal: desked.memory };
  };
  const quiet = (world: World): World => { const next = step(world); return next.board.length === world.board.length ? next : quiet(next); };
  const withdraw = (world: World): World => {
    const withdrawn = withdrawTruck(haulierContext, world.haulier, 'the driver is unavailable', 'rotterdam:truck:truck-1930');
    return { ...world, board: [...world.board, ...withdrawn.posts], haulier: withdrawn.memory };
  };
  return { quiet, withdraw };
};

/** Every offer the story makes, the recovered plan's first, then what it replaced, then what was never held. */
const story = [
  'rotterdam:unload:unload-1800', `rotterdam:storage:R-114:${at(8)}/${at(11)}`, 'rotterdam:truck:truck-2100',
  `rotterdam:storage:R-114:${at(8)}/${at(9.5)}`, 'rotterdam:truck:truck-1930', `rotterdam:storage:R-114:${at(8)}/${at(9)}`, 'rotterdam:truck:truck-1700',
] as const;

const run = () => {
  const ledger = createBookings(':memory:', () => Date.parse(now));
  const { quiet, withdraw } = society(ledger);
  const opened: World = { board: [], cargo: openCase(caseId, { id: 'cargo-gz-1042', vessel: 'Meridian Star' }, reeferCommitments(anchor)), haulier: emptyHaulierMemory, terminal: emptyTerminalMemory };
  return { ledger, board: quiet(withdraw(quiet(opened))).board };
};

describe('act 2 through the agents\' own decisions on the world\'s numbers', () => {
  test('blocked by the 17:00 truck, then by power, it fits at 20:45 for EUR 1002.5; after the 19:30 truck is withdrawn, at 22:15 for EUR 1185', () => {
    const { board } = run();
    expect(board.flatMap(message => message.kind === 'recovery.plan' ? [message.outcome.status === 'fits' ? ['fits', message.outcome.plan.delivered, message.outcome.plan.totalEur] : ['blocked', message.outcome.blocking.kind]] : [])).toEqual([
      ['blocked', 'truck-before-unload'], ['blocked', 'storage-gap'], ['fits', at(11.75), 1002.5],
      ['blocked', 'truck-before-unload'], ['blocked', 'storage-gap'], ['fits', at(13.25), 1185],
    ]);
    expect(board.flatMap(message => message.kind === 'recovery.offer' ? [[message.offer.id, message.author.role, message.offer.priceEur]] : []).toSorted()).toEqual([
      [`rotterdam:storage:R-114:${at(8)}/${at(9)}`, 'city', 95], [`rotterdam:storage:R-114:${at(8)}/${at(9.5)}`, 'city', 142.5], [`rotterdam:storage:R-114:${at(8)}/${at(11)}`, 'city', 285],
      ['rotterdam:truck:truck-1700', 'haulier', 640], ['rotterdam:truck:truck-1930', 'haulier', 720], ['rotterdam:truck:truck-2100', 'haulier', 760],
      ['rotterdam:unload:unload-1800', 'city', 140],
    ]);
  });

  test('every post cites only what is already on the board', () => {
    const { board } = run();
    expect(board.flatMap((message, index) => message.answers.filter(id => !board.slice(0, index).some(earlier => earlier.id === id)).map(id => [message.id, id]))).toEqual([]);
  });

  test('the ledger ends with the recovered plan confirmed at EUR 1185 and what it replaced released, each booked once, the unload never touched', () => {
    const { ledger, board } = run();
    const booked = story.map(offerId => ledger.find(bookingKey(caseId, offerId)));
    expect(booked.map(booking => booking ? [booking.status, booking.priceEur] : null)).toEqual([
      ['confirmed', 140], ['confirmed', 285], ['confirmed', 760], ['released', 142.5], ['released', 720], null, null,
    ]);
    expect(ledger.list(workspaceId).map(row => row.id).toSorted()).toEqual(booked.flatMap(booking => booking ? [booking.id] : []).toSorted());
    expect(board.flatMap(message => 'offerId' in message && message.offerId === 'rotterdam:unload:unload-1800' ? [message.kind] : [])).toEqual(['recovery.hold', 'recovery.confirm']);
  });

  test('the providers write the rows on their own resources, the crane window, the plug R-114 and the trucks, each held for the cargo agent', () => {
    const { ledger } = run();
    expect(story.flatMap(offerId => { const booking = ledger.find(bookingKey(caseId, offerId)); return booking ? [[booking.resource, booking.heldBy]] : []; })).toEqual([
      ['rotterdam:unload:unload-1800', 'cargo:cargo-gz-1042'], ['rotterdam:plug:R-114', 'cargo:cargo-gz-1042'], ['rotterdam:truck:truck-2100', 'cargo:cargo-gz-1042'],
      ['rotterdam:plug:R-114', 'cargo:cargo-gz-1042'], ['rotterdam:truck:truck-1930', 'cargo:cargo-gz-1042'],
    ]);
  });
});
