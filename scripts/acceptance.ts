// Automated run of the README demo journey against a running Gazetteer.
//   bun scripts/acceptance.ts <origin> [--restart-cmd "<shell command>"] [--budget-ready 600] [--budget-window 180] [--budget-sse 30] [--budget-restart 240]
// Prints a PASS/FAIL/SKIP table with measured times and exits non-zero on any FAIL. Tooling, not shipped code.
import { citations, type BoardMessage, type CityReport, type EtaNotice, type ShipAssessment, type ShipObservation } from '../src/core/board.js';
import type { Dashboard, Shipment } from '../src/core/types.js';

type Status = 'PASS' | 'FAIL' | 'SKIP';
type Row = Readonly<{ id: string; name: string; status: Status; ms: number | null; budget: string; detail: string }>;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const origin = (args.find(arg => /^https?:\/\//.test(arg)) ?? 'http://localhost:4310').replace(/\/+$/, '');
const restartCmd = flag('restart-cmd');
const seconds = (name: string, fallback: number): number => Number(flag(name) ?? fallback) * 1000;
const BUDGET = { readyMs: seconds('budget-ready', 600), dashboardMs: 250, p95Ms: 50, windowMs: seconds('budget-window', 180), disruptionMs: 2500, etaMs: seconds('budget-eta', 120), boardMs: seconds('budget-board', 120), riskMs: seconds('budget-risk', 120), restartMs: seconds('budget-restart', 240), sseMs: seconds('budget-sse', 30) };
const HOURS = 36;
const EXPOSED = ['gz-1042', 'gz-1044'] as const;
const UNAFFECTED = ['gz-1043', 'gz-1045'] as const;

const rows: Row[] = [];
let startupTag = 'startup ?';
const record = (row: Row): Row => {
  const stamped: Row = { ...row, detail: [row.detail, startupTag].filter(Boolean).join('; ') };
  rows.push(stamped);
  console.log(`  ${stamped.status}  ${stamped.id.padEnd(5)} ${stamped.name}${stamped.ms === null ? '' : `  [${stamped.ms} ms]`}  ${stamped.detail}`);
  return stamped;
};
const verdict = (id: string, name: string, ok: boolean, ms: number | null, budget: string, detail = ''): Row => record({ id, name, status: ok ? 'PASS' : 'FAIL', ms, budget, detail });
const now = (): number => performance.now();
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const elapsed = (since: number): number => Math.round(now() - since);

type Session = { cookie: string; workspaceId: string };
const headers = (session: Session | null, extra: Record<string, string> = {}): Record<string, string> => ({ Origin: origin, ...(session ? { Cookie: session.cookie } : {}), ...extra });

const enterDemo = async (): Promise<Readonly<{ session: Session | null; ms: number; detail: string }>> => {
  const started = now();
  const response = await fetch(`${origin}/api/demo-session`, { method: 'POST', headers: headers(null) }).catch((error: unknown) => error instanceof Error ? error : new Error('network'));
  const ms = elapsed(started);
  if (response instanceof Error) return { session: null, ms, detail: response.message };
  if (response.status !== 200) return { session: null, ms, detail: `HTTP ${response.status}` };
  const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  const body = await response.json().catch(() => null) as { workspaces?: readonly { id: string; name: string }[] } | null;
  const workspace = body?.workspaces?.[0];
  return cookie && workspace ? { session: { cookie, workspaceId: workspace.id }, ms, detail: `workspace "${workspace.name}"` } : { session: null, ms, detail: 'no cookie or workspace in response' };
};

const getDashboard = async (session: Session): Promise<Readonly<{ dashboard: Dashboard | null; ms: number; status: number }>> => {
  const started = now();
  const response = await fetch(`${origin}/api/workspaces/${session.workspaceId}/dashboard`, { headers: headers(session) }).catch(() => null);
  const ms = elapsed(started);
  if (!response) return { dashboard: null, ms, status: 0 };
  const dashboard = response.ok ? await response.json().catch(() => null) as Dashboard | null : null;
  if (dashboard) startupTag = dashboard.startup ? `startup ${dashboard.startup.ready}/${dashboard.startup.total}` : 'startup complete';
  return { dashboard, ms, status: response.status };
};

const poll = async <A>(session: Session, budgetMs: number, test: (dashboard: Dashboard) => A | false): Promise<Readonly<{ value: A | null; ms: number }>> => {
  const started = now();
  while (now() - started < budgetMs) {
    const { dashboard } = await getDashboard(session);
    const value = dashboard ? test(dashboard) : false;
    if (value !== false) return { value, ms: elapsed(started) };
    await sleep(400);
  }
  return { value: null, ms: elapsed(started) };
};

/** Every timing below means something only once the actors are up: a ship that has not initialised cannot react, whatever the code says. */
const isReady = (dashboard: Dashboard): boolean => dashboard.startup === undefined || dashboard.startup.ready >= dashboard.startup.total;
const waitReady = async (session: Session, budgetMs: number): Promise<Readonly<{ dashboard: Dashboard | null; ms: number; ok: boolean }>> => {
  const started = now();
  let last: Dashboard | null = null;
  while (now() - started < budgetMs) {
    last = (await getDashboard(session)).dashboard ?? last;
    if (last && isReady(last)) return { dashboard: last, ms: elapsed(started), ok: true };
    await sleep(1000);
  }
  return { dashboard: last, ms: elapsed(started), ok: false };
};

type SseEvent = Readonly<{ event: string; at: number; data: string }>;
const openStream = (session: Session, sink: SseEvent[], abort: AbortController): Promise<number | null> =>
  fetch(`${origin}/api/workspaces/${session.workspaceId}/events`, { headers: headers(session, { Accept: 'text/event-stream' }), signal: abort.signal }).then(async response => {
    if (!response.ok || !response.body) return response.status;
    void (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const lines = frame.split('\n');
          const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
          if (event) sink.push({ event, at: now(), data: lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n') });
        }
      }
    })().catch(() => undefined);
    return null;
  }).catch(() => -1);

const byId = (dashboard: Dashboard, id: string): Shipment | undefined => dashboard.shipments.find(ship => ship.id === id);
/** The disruption's own delay plus whatever the society adds on top of it (a traffic watch can add hours to an inbound ship); never less, never absurdly more. */
const delayedBy = (eta: string, was: string, hours: number): boolean => { const added = (Date.parse(eta) - Date.parse(was)) / 3_600_000; return added >= hours - 1 / 60 && added <= hours + 12; };
const sameInstant = (a: string, b: string): boolean => Math.abs(Date.parse(a) - Date.parse(b)) < 1000;
/** Sub-minute drift is the server re-anchoring its clock, not a revised estimate. */
const moved = (a: string, b: string): boolean => Math.abs(Date.parse(a) - Date.parse(b)) >= 60_000;

type Baseline = ReadonlyMap<string, Readonly<{ eta: string; risk: Shipment['risk']; evidence: number }>>;
const baselineOf = (dashboard: Dashboard): Baseline => new Map(dashboard.shipments.map(ship => [ship.id, { eta: ship.eta, risk: ship.risk, evidence: ship.evidence.length }]));

/** The exposed ships delayed by exactly HOURS with a new evidence record, the unaffected ones untouched. */
const exposureOutcome = (dashboard: Dashboard, before: Baseline): Readonly<{ exposedDone: boolean; detail: string }> => {
  const exposed = EXPOSED.map(id => ({ id, ship: byId(dashboard, id), was: before.get(id) }));
  const done = exposed.every(({ ship, was }) => ship && was && ship.risk === 'delayed' && delayedBy(ship.eta, was.eta, HOURS) && ship.evidence.length > was.evidence);
  return { exposedDone: done, detail: exposed.map(({ id, ship, was }) => `${id}:${ship?.risk ?? '?'} ${ship && was ? `${(Date.parse(ship.eta) - Date.parse(was.eta)) / 3_600_000}h` : ''} ev+${ship && was ? ship.evidence.length - was.evidence : '?'}`).join(' ') };
};
const unaffectedHeld = (dashboard: Dashboard, before: Baseline): boolean =>
  UNAFFECTED.every(id => { const ship = byId(dashboard, id); const was = before.get(id); return ship && was && sameInstant(ship.eta, was.eta) && ship.risk === 'on-track'; });

const boardIds = (dashboard: Dashboard): ReadonlySet<string> => new Set((dashboard.board ?? []).map(message => message.id));

/** Singapore's traffic watch at elevated/severe citing at least one anchored (stopped-outside-port) observations near Singapore. */
const anchoredWatch = (messages: readonly BoardMessage[]): Extract<CityReport, { kind: 'city.traffic' }> | null => {
  const anchored = new Set(messages.filter((message): message is ShipObservation => message.kind === 'ship.observation' && message.nearPort === 'singapore' && message.signals.includes('stationary-outside-port')).map(message => message.id));
  return messages.find((message): message is Extract<CityReport, { kind: 'city.traffic' }> => message.kind === 'city.traffic' && message.author.city === 'singapore' && message.risk !== 'normal' && citations(message).filter(id => anchored.has(id)).length >= 1) ?? null;
};

type Chain = Readonly<{ observation: ShipObservation | undefined; watch: Extract<CityReport, { kind: 'city.traffic' }> | undefined; assessments: readonly ShipAssessment[] }>;

/** The first chain the board holds: an observation near Singapore that Singapore's traffic watch cites at elevated/severe, and the other inbound ships' assessments citing that watch. */
const buildChain = (messages: readonly BoardMessage[], inbound: (shipmentId: string) => boolean): Chain => {
  const observations = messages.filter((message): message is ShipObservation => message.kind === 'ship.observation' && message.nearPort === 'singapore');
  const traffic = messages.filter((message): message is Extract<CityReport, { kind: 'city.traffic' }> => message.kind === 'city.traffic' && message.author.city === 'singapore' && message.risk !== 'normal');
  const links = traffic.flatMap(watch => observations.filter(observation => citations(watch).includes(observation.id)).map(observation => ({ watch, observation })));
  const link = links[0];
  if (!link) return { observation: observations[0], watch: undefined, assessments: [] };
  const assessments = messages.filter((message): message is ShipAssessment => message.kind === 'ship.assessment' && message.shipmentId !== link.observation.shipmentId && inbound(message.shipmentId) && message.citedEvidence.includes(link.watch.id));
  const byShip = new Map(assessments.map(message => [message.shipmentId, message]));
  return { observation: link.observation, watch: link.watch, assessments: [...byShip.values()] };
};

/** Every shipment whose ETA moved since the baseline, and whether evidence accounts for it: a new evidence record, a ship.eta citing something, or a new ship.assessment citing something (a ship's first ETA notice carries no citation; its assessment does). */
const etaMoves = (dashboard: Dashboard | null, before: Baseline, messages: readonly BoardMessage[], knownBoard: ReadonlySet<string>): readonly Readonly<{ shipmentId: string; carries: boolean }>[] => {
  const notices = messages.filter((message): message is EtaNotice => message.kind === 'ship.eta' && !knownBoard.has(message.id));
  const assessments = messages.filter((message): message is ShipAssessment => message.kind === 'ship.assessment' && !knownBoard.has(message.id));
  return (dashboard?.shipments ?? []).flatMap(ship => {
    const was = before.get(ship.id);
    if (!was || !moved(ship.eta, was.eta)) return [];
    const cited = notices.some(notice => notice.shipmentId === ship.id && notice.citedEvidence !== undefined && notice.citedEvidence.length > 0)
      || assessments.some(assessment => assessment.shipmentId === ship.id && assessment.citedEvidence.length > 0);
    return [{ shipmentId: ship.id, carries: cited || ship.evidence.length > was.evidence }];
  });
};

async function main(): Promise<void> {
  console.log(`Gazetteer acceptance against ${origin}\n`);

  // 1. demo session and the dashboard's responsiveness
  const entered = await enterDemo();
  verdict('1a', 'POST /api/demo-session issues a session', entered.session !== null, entered.ms, '', entered.detail);
  const session = entered.session;
  if (!session) return finish();
  const first = await getDashboard(session);
  verdict('1b', 'GET dashboard answers fast, whatever the startup state', first.dashboard !== null && first.ms < BUDGET.dashboardMs, first.ms, `< ${BUDGET.dashboardMs} ms`, `HTTP ${first.status}`);
  const reads: number[] = [];
  for (let index = 0; index < 20; index += 1) reads.push((await getDashboard(session)).ms);
  const sorted = [...reads].sort((x, y) => x - y);
  const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1] ?? Infinity;
  verdict('1c', 'dashboard p95 over 20 reads', p95 < BUDGET.p95Ms, p95, `< ${BUDGET.p95Ms} ms`, `median ${sorted[10]} ms, max ${sorted[19]} ms`);

  // 2. readiness, then the fleet: the baseline is taken once every actor is up
  const ready = await waitReady(session, BUDGET.readyMs);
  verdict('2a', 'every actor is ready (dashboard startup.ready == total)', ready.ok, ready.ms, `<= ${BUDGET.readyMs / 1000} s`, ready.ok ? '' : 'timed out; timings below measure startup, not the code');
  const baseline = ready.dashboard ?? first.dashboard;
  if (!baseline) return finish();
  const readyAt = now();
  const ids = baseline.shipments.map(ship => ship.id);
  verdict('2b', 'the demo fleet is present: at least 11 ships, including gz-1042..gz-1045', ids.length >= 11 && [...EXPOSED, ...UNAFFECTED].every(id => ids.includes(id)), null, '>= 11', `${ids.length} ships`);

  // 3-5. disruption: stream open first, then POST; one loop watches the whole society for the scenario window
  const before = baselineOf(baseline);
  const knownBoard = boardIds(baseline);
  const events: SseEvent[] = [];
  const abort = new AbortController();
  const streamFailure = await openStream(session, events, abort);
  await sleep(1000);
  const posted = now();
  const response = await fetch(`${origin}/api/workspaces/${session.workspaceId}/disruptions`, { method: 'POST', headers: headers(session, { 'Content-Type': 'application/json' }), body: JSON.stringify({ portId: 'singapore', delayHours: HOURS }) }).catch(() => null);
  const postMs = elapsed(posted);
  verdict('3a', `POST Singapore +${HOURS}h is accepted quickly`, response !== null && response.status < 300 && postMs < BUDGET.disruptionMs, postMs, `< ${BUDGET.disruptionMs} ms`, `HTTP ${response?.status ?? 'no response'}`);

  const seen = new Map<string, Readonly<{ message: BoardMessage; firstSeenMs: number }>>(); // every board message, by id, when first read
  for (const message of baseline.board ?? []) seen.set(message.id, { message, firstSeenMs: -1 });
  const firstAt: Record<string, number | undefined> = {};
  const mark = (key: string, happened: boolean): void => { if (happened && firstAt[key] === undefined) firstAt[key] = elapsed(posted); };
  let latest: Dashboard | null = baseline;
  const everything = (): readonly BoardMessage[] => [...seen.values()].map(entry => entry.message);
  const inbound = (shipmentId: string): boolean => { const ship = latest ? byId(latest, shipmentId) : undefined; return ship !== undefined && (ship.destination === 'singapore' || ship.via.includes('singapore')); };
  const chainOf = (): Chain => buildChain(everything(), inbound);
  while (now() - posted < BUDGET.windowMs) {
    const { dashboard } = await getDashboard(session);
    if (dashboard) {
      latest = dashboard;
      for (const message of dashboard.board ?? []) if (!seen.has(message.id)) seen.set(message.id, { message, firstSeenMs: elapsed(posted) });
      const outcome = exposureOutcome(dashboard, before);
      mark('exposure', outcome.exposedDone);
      mark('risk', dashboard.portStatus?.find(item => item.portId === 'singapore')?.risk !== 'normal' && dashboard.portStatus?.some(item => item.portId === 'singapore') === true);
      const chain = chainOf();
      mark('observation', chain.observation !== undefined);
      mark('watch', chain.watch !== undefined);
      mark('anchored', anchoredWatch(dashboard.board ?? []) !== null);
      mark('assessments', chain.assessments.length >= 2);
    }
    if (['exposure', 'risk', 'anchored', 'observation', 'watch', 'assessments'].every(key => firstAt[key] !== undefined)) break;
    await sleep(400);
  }
  const outcome = latest ? exposureOutcome(latest, before) : null;
  verdict('3b', `gz-1042 and gz-1044 are delayed by at least +${HOURS}h (the watches may add hours) with a new evidence record`, firstAt.exposure !== undefined, firstAt.exposure ?? null, `<= ${BUDGET.windowMs / 1000} s`, outcome?.detail ?? 'no dashboard');
  verdict('3c', 'gz-1043 and gz-1045 keep their ETA and stay on-track', latest !== null && unaffectedHeld(latest, before), null, '', latest ? UNAFFECTED.map(id => `${id}:${byId(latest as Dashboard, id)?.risk ?? '?'}`).join(' ') : 'no dashboard');
  verdict('3d', 'the added evidence is simulated and labelled', latest !== null && EXPOSED.every(id => ((latest as Dashboard).shipments.find(ship => ship.id === id)?.evidence ?? []).slice(before.get(id)?.evidence ?? 0).some(item => item.source === 'simulation')), null, '', '');
  const sinceReady = Math.round(posted - readyAt);
  const anchoredAt = firstAt.anchored === undefined ? null : firstAt.anchored + sinceReady;
  const sgWatch = anchoredWatch(everything());
  verdict('4c', 'within the window of full readiness, Singapore traffic watch is elevated/severe citing an anchored observation, and portStatus agrees', anchoredAt !== null && firstAt.risk !== undefined, anchoredAt, `<= ${BUDGET.windowMs / 1000} s after ready`, `portStatus ${latest?.portStatus?.find(item => item.portId === 'singapore')?.risk ?? 'no status'}; watch ${sgWatch ? `${sgWatch.risk} ${sgWatch.id.slice(0, 40)}` : 'none'}`);

  // the society chain: observation -> Singapore traffic watch citing it -> two other inbound ships citing the watch -> every ETA move carries evidence
  const chain = chainOf();
  const id = (message: BoardMessage | undefined): string => message ? message.id.slice(0, 40) : '-';
  verdict('B1', 'a ship.observation near Singapore', chain.observation !== undefined, firstAt.observation ?? null, `<= ${BUDGET.windowMs / 1000} s`, `${id(chain.observation)}${chain.observation ? ` (${chain.observation.shipmentId})` : ''}`);
  verdict('B2', 'Singapore traffic watch posts elevated/severe, citing that observation', chain.watch !== undefined, firstAt.watch ?? null, `<= ${BUDGET.windowMs / 1000} s`, chain.watch ? `${id(chain.watch)} ${chain.watch.risk}` : `${everything().filter(message => message.kind === 'city.traffic').length} traffic post(s), none citing an observation at elevated/severe`);
  verdict('B3', 'at least 2 other Singapore-bound ships assess, citing the watch', chain.assessments.length >= 2, firstAt.assessments ?? null, `<= ${BUDGET.windowMs / 1000} s`, chain.assessments.length ? chain.assessments.map(message => `${message.shipmentId}:${id(message)}`).join(' ') : 'none');
  const moves = etaMoves(latest, before, everything(), knownBoard);
  verdict('C', 'every ETA move carries evidence', moves.length > 0 && moves.every(move => move.carries), null, '', moves.length === 0 ? 'no ETA moved' : moves.map(move => `${move.shipmentId}:${move.carries ? 'cited' : 'NO EVIDENCE'}`).join(' '));

  // 5. SSE
  const carries = (item: SseEvent): boolean => { try { return exposureOutcome(JSON.parse(item.data) as Dashboard, before).exposedDone; } catch { return false; } };
  const sseStarted = now();
  while (now() - sseStarted < BUDGET.sseMs && !events.some(item => item.event === 'dashboard' && item.at >= posted && carries(item))) await sleep(250);
  const afterPost = events.filter(item => item.event === 'dashboard' && item.at >= posted);
  const carrying = afterPost.find(carries);
  verdict('5', 'SSE client receives a dashboard event carrying the disruption', streamFailure === null && carrying !== undefined, carrying ? Math.round(carrying.at - posted) : null, 'after POST', streamFailure === null ? `${afterPost.length} dashboard event(s) after POST, first at ${afterPost[0] ? Math.round(afterPost[0].at - posted) : '-'} ms; carrying the +${HOURS}h state: ${carrying ? 'yes' : 'no'}` : `stream HTTP ${streamFailure}`);
  abort.abort();

  // 6. restart keeps state
  if (!restartCmd) {
    record({ id: '6', name: 'restart keeps the state', status: 'SKIP', ms: null, budget: '', detail: 'manual: restart the server now (same DATA_DIR and .env), then rerun with the same origin; re-verification of 3b/3c needs the pre-disruption baseline, so prefer --restart-cmd' });
    console.log('\n  Manual restart checklist:\n   1. stop the server process (SIGTERM), keep DATA_DIR and .env\n   2. start it again\n   3. open /demo and confirm gz-1042 and gz-1044 are still Delayed with +36h and the evidence record\n   4. gz-1043 and gz-1045 still On schedule');
    return finish();
  }
  const restarting = now();
  const run = Bun.spawn(['sh', '-c', restartCmd], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
  const exitCode = await run.exited;
  verdict('6a', 'restart command succeeds', exitCode === 0, elapsed(restarting), '', `exit ${exitCode}`);
  const back = await (async (): Promise<Readonly<{ session: Session | null; ms: number }>> => {
    const started = now();
    while (now() - started < BUDGET.restartMs) {
      const attempt = await enterDemo();
      if (attempt.session) return { session: attempt.session, ms: elapsed(started) };
      await sleep(1000);
    }
    return { session: null, ms: elapsed(started) };
  })();
  verdict('6b', 'the server answers again after restart', back.session !== null, back.ms, `<= ${BUDGET.restartMs / 1000} s`, '');
  if (!back.session) return finish();
  const settledAgain = await waitReady(back.session, BUDGET.readyMs);
  verdict('6b2', 'every actor is ready again after restart', settledAgain.ok, settledAgain.ms, `<= ${BUDGET.readyMs / 1000} s`, '');
  const afterRestart = await poll(back.session, BUDGET.etaMs, dashboard => exposureOutcome(dashboard, before).exposedDone ? dashboard : false);
  const restored = afterRestart.value ?? (await getDashboard(back.session)).dashboard;
  verdict('6c', 'gz-1042 and gz-1044 are still delayed +36h with their evidence', afterRestart.value !== null, afterRestart.ms, `<= ${BUDGET.etaMs / 1000} s`, restored ? exposureOutcome(restored, before).detail : 'no dashboard');
  verdict('6d', 'gz-1043 and gz-1045 are still untouched', restored !== null && unaffectedHeld(restored, before), null, '', '');
  return finish();
}

function finish(): void {
  const failed = rows.filter(row => row.status === 'FAIL');
  const width = Math.max(...rows.map(row => row.name.length));
  console.log(`\n${'#'.padEnd(4)} ${'check'.padEnd(width)}  result  measured   budget`);
  rows.forEach(row => console.log(`${row.id.padEnd(4)} ${row.name.padEnd(width)}  ${row.status.padEnd(6)}  ${(row.ms === null ? '-' : `${row.ms} ms`).padEnd(9)}  ${row.budget}`));
  console.log(`\n${rows.filter(row => row.status === 'PASS').length} pass, ${failed.length} fail, ${rows.filter(row => row.status === 'SKIP').length} skipped`);
  process.exit(failed.length > 0 ? 1 : 0);
}

await main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); verdict('X', 'acceptance script error', false, null, '', error instanceof Error ? error.message : String(error)); finish(); });
finish();
