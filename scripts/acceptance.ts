// Automated run of the README demo journey against a running Gazetteer.
//   bun scripts/acceptance.ts <origin> [--restart-cmd "<shell command>"] [--budget-eta 120] [--budget-board 120] [--budget-risk 120] [--budget-sse 30] [--budget-restart 240]
// Prints a PASS/FAIL/SKIP table with measured times and exits non-zero on any FAIL. Tooling, not shipped code.
import type { Dashboard, Shipment } from '../src/core/types';

type Status = 'PASS' | 'FAIL' | 'SKIP';
type Row = Readonly<{ id: string; name: string; status: Status; ms: number | null; budget: string; detail: string }>;

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const origin = (args.find(arg => /^https?:\/\//.test(arg)) ?? 'http://localhost:4310').replace(/\/+$/, '');
const restartCmd = flag('restart-cmd');
const seconds = (name: string, fallback: number): number => Number(flag(name) ?? fallback) * 1000;
const BUDGET = { dashboardMs: 250, disruptionMs: 1500, etaMs: seconds('budget-eta', 120), boardMs: seconds('budget-board', 120), riskMs: seconds('budget-risk', 120), restartMs: seconds('budget-restart', 240), sseMs: seconds('budget-sse', 30) };
const HOURS = 36;
const EXPOSED = ['gz-1042', 'gz-1044'] as const;
const UNAFFECTED = ['gz-1043', 'gz-1045'] as const;

const rows: Row[] = [];
const record = (row: Row): Row => { rows.push(row); console.log(`  ${row.status}  ${row.id.padEnd(5)} ${row.name}${row.ms === null ? '' : `  [${row.ms} ms]`}${row.detail ? `  ${row.detail}` : ''}`); return row; };
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
const shiftedHours = (eta: string, hours: number): string => new Date(Date.parse(eta) + hours * 3_600_000).toISOString();
const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);

type Baseline = ReadonlyMap<string, Readonly<{ eta: string; risk: Shipment['risk']; evidence: number }>>;
const baselineOf = (dashboard: Dashboard): Baseline => new Map(dashboard.shipments.map(ship => [ship.id, { eta: ship.eta, risk: ship.risk, evidence: ship.evidence.length }]));

/** The exposed ships delayed by exactly HOURS with a new evidence record, the unaffected ones untouched. */
const exposureOutcome = (dashboard: Dashboard, before: Baseline): Readonly<{ exposedDone: boolean; detail: string }> => {
  const exposed = EXPOSED.map(id => ({ id, ship: byId(dashboard, id), was: before.get(id) }));
  const done = exposed.every(({ ship, was }) => ship && was && ship.risk === 'delayed' && sameInstant(ship.eta, shiftedHours(was.eta, HOURS)) && ship.evidence.length > was.evidence);
  return { exposedDone: done, detail: exposed.map(({ id, ship, was }) => `${id}:${ship?.risk ?? '?'} ${ship && was ? `${(Date.parse(ship.eta) - Date.parse(was.eta)) / 3_600_000}h` : ''} ev+${ship && was ? ship.evidence.length - was.evidence : '?'}`).join(' ') };
};
const unaffectedHeld = (dashboard: Dashboard, before: Baseline): boolean =>
  UNAFFECTED.every(id => { const ship = byId(dashboard, id); const was = before.get(id); return ship && was && sameInstant(ship.eta, was.eta) && ship.risk === 'on-track'; });

const boardIds = (dashboard: Dashboard): ReadonlySet<string> => new Set((dashboard.board ?? []).map(message => message.id));

async function main(): Promise<void> {
  console.log(`Gazetteer acceptance against ${origin}\n`);

  // 1. demo session and the dashboard's responsiveness
  const entered = await enterDemo();
  verdict('1a', 'POST /api/demo-session issues a session', entered.session !== null, entered.ms, '', entered.detail);
  const session = entered.session;
  if (!session) return finish();
  const first = await getDashboard(session);
  const startupNote = first.dashboard?.startup ? `startup ${first.dashboard.startup.ready}/${first.dashboard.startup.total}` : 'startup complete';
  verdict('1b', 'GET dashboard answers fast, whatever the startup state', first.dashboard !== null && first.ms < BUDGET.dashboardMs, first.ms, `< ${BUDGET.dashboardMs} ms`, `HTTP ${first.status}; ${startupNote}`);
  const repeats = await Promise.all([0, 1, 2].map(async () => (await getDashboard(session)).ms));
  verdict('1c', 'three further dashboard reads stay under budget', repeats.every(ms => ms < BUDGET.dashboardMs), Math.max(...repeats), `< ${BUDGET.dashboardMs} ms`, `reads ${repeats.join(', ')} ms`);

  // 2. the fleet
  const baseline = first.dashboard;
  if (!baseline) return finish();
  const ids = baseline.shipments.map(ship => ship.id);
  verdict('2', 'the demo fleet is present: at least 11 ships, including gz-1042..gz-1045', ids.length >= 11 && [...EXPOSED, ...UNAFFECTED].every(id => ids.includes(id)), null, '>= 11', `${ids.length} ships`);

  // 3-5. disruption: stream open first, then POST
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

  const exposure = await poll(session, BUDGET.etaMs, dashboard => exposureOutcome(dashboard, before).exposedDone ? dashboard : false);
  const latest = exposure.value ?? (await getDashboard(session)).dashboard;
  verdict('3b', `gz-1042 and gz-1044 are delayed by exactly +${HOURS}h with a new evidence record`, exposure.value !== null, exposure.ms, `<= ${BUDGET.etaMs / 1000} s`, latest ? exposureOutcome(latest, before).detail : 'no dashboard');
  verdict('3c', 'gz-1043 and gz-1045 keep their ETA and stay on-track', latest !== null && unaffectedHeld(latest, before), null, '', latest ? UNAFFECTED.map(id => `${id}:${byId(latest, id)?.risk ?? '?'}`).join(' ') : 'no dashboard');
  const evidence = latest ? EXPOSED.map(id => byId(latest, id)?.evidence.slice(before.get(id)?.evidence ?? 0).map(item => item.id).join('|') ?? '') : [];
  verdict('3d', 'the added evidence is simulated and labelled', latest !== null && EXPOSED.every(id => (byId(latest, id)?.evidence ?? []).slice(before.get(id)?.evidence ?? 0).some(item => item.source === 'simulation')), null, '', evidence.join(' ; '));

  // 4. the board
  const boardAfter = await poll(session, BUDGET.boardMs, dashboard => {
    const added = (dashboard.board ?? []).filter(message => !knownBoard.has(message.id));
    const assessment = added.find(message => message.kind === 'ship.assessment' && (EXPOSED as readonly string[]).includes(message.shipmentId));
    const eta = added.find(message => message.kind === 'ship.eta' && (EXPOSED as readonly string[]).includes(message.shipmentId));
    const traffic = added.find(message => message.kind === 'city.traffic' && message.author.city === 'singapore');
    return assessment && eta && traffic ? { assessment, eta, traffic } : false;
  });
  const seen = latest?.board ?? [];
  const kinds = [...new Set(seen.filter(message => !knownBoard.has(message.id)).map(message => message.kind))].join(', ');
  verdict('4a', 'board gains a ship.assessment, a ship.eta and a Singapore traffic watch report', boardAfter.value !== null, boardAfter.ms, `<= ${BUDGET.boardMs / 1000} s`, boardAfter.value ? `assessment ${boardAfter.value.assessment.kind === 'ship.assessment' ? `${boardAfter.value.assessment.method}, cites ${boardAfter.value.assessment.citedEvidence.length}` : ''}` : `new kinds seen so far: ${kinds || 'none'}`);
  const cited = boardAfter.value?.assessment.kind === 'ship.assessment' && boardAfter.value.assessment.citedEvidence.length > 0;
  verdict('4b', 'the assessment cites evidence', boardAfter.value !== null && cited, null, '', '');
  const risk = await poll(session, BUDGET.riskMs, dashboard => { const status = dashboard.portStatus?.find(item => item.portId === 'singapore'); return status && status.risk !== 'normal' ? status : false; });
  verdict('4c', 'Singapore portStatus.risk reaches elevated or severe', risk.value !== null, risk.ms, `<= ${BUDGET.riskMs / 1000} s`, risk.value ? `${risk.value.risk}, relevance ${risk.value.relevance}` : 'still normal');

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
