import { describe, expect, test } from 'bun:test';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { demoShipments } from '../../../src/core/demo';
import { assessNotice, type AssessModel, type MindContext, type ModelRequest } from '../../../src/server/assessment/assess';
import type { AssessableNotice } from '../../../src/server/assessment/exposure';
import { answerTool, boundedPool, settleMind, shipMind, shipMindFromEnv, type MindConfig, type MindQuery } from '../../../src/server/assessment/mind';
import type { BoardEvidence } from '../../../src/server/assessment/prompt';
import type { Assessment } from '../../../src/server/assessment/schema';

const at = '2026-10-31T12:00:00.000Z';
const [meridian] = demoShipments(new Date(at)) as [ReturnType<typeof demoShipments>[number]];
const notice: AssessableNotice = { id: 'sg-1', portId: 'singapore', delayHours: 36,
  evidence: { id: 'sg-1', source: 'simulation', title: 'Berth congestion', detail: 'Simulated congestion at Singapore.', observedAt: at } };
const bulletin: BoardEvidence = { id: 'board-sg-7', kind: 'port.bulletin', at, summary: 'Singapore elevated: 4 anchored', facts: { portId: 'singapore', risk: 'elevated', anchored: 4, arrivals48h: 9 } };
const context: MindContext = { shipment: meridian, board: [bulletin], observation: null };
const good: Assessment = { affected: true, delayHours: { low: 12, likely: 20, high: 40 }, risk: 'watch', rationale: 'Berth queue at the next call.', citedEvidence: ['sg-1', 'board-sg-7'], confidence: 0.6, action: null };
const request = (session: string | null): ModelRequest => ({ system: 'assess', prompt: '{}', session, context });

const scripted = (messages: readonly unknown[], end?: Error): Readonly<{ run: MindQuery; seen: Options[] }> => {
  const seen: Options[] = [];
  const run: MindQuery = ({ options }) => {
    seen.push(options);
    return (async function* () { yield* messages; if (end) throw end; })();
  };
  return { run, seen };
};
const init = (session: string) => ({ type: 'system', subtype: 'init', session_id: session, tools: [] });
const decided = (session: string, output: unknown) => ({ type: 'result', subtype: 'success', is_error: false, session_id: session, structured_output: output, result: '' });
const used = (session: string, name: string, input: unknown = {}) => ({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', id: 't', name, input }] } });
const configIn = async (timeoutMs = 5_000): Promise<MindConfig> =>
  ({ apiKey: 'test-key', workspaceId: 'wrkspc_test', model: 'claude-haiku-5-5', mindsDir: await mkdtemp(join(tmpdir(), 'gazetteer-minds-')), executable: '/opt/claude', path: '/usr/bin', timeoutMs });

describe('the ship mind is locked to its own tools', () => {
  test('no built-in tool, no settings, no user config, only ship tools, bounded turns', async () => {
    process.env.GAZETTEER_PARENT_SECRET = 'parent-only-secret';
    const config = await configIn();
    const { run, seen } = scripted([init('voyage-1'), decided('voyage-1', good)]);
    await shipMind(run, config)(request(null));
    const options = seen[0]!;
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.allowedTools?.every(name => name.startsWith('mcp__ship__'))).toBe(true);
    expect(options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'Read', 'Write', 'Edit', 'WebFetch', 'WebSearch', 'Task']));
    expect(options.maxTurns).toBeLessThanOrEqual(4);
    expect(options.model).toBe('claude-haiku-5-5');
    expect(String(options.systemPrompt)).toStartWith(`You are ${meridian.agent}, the mind aboard ${meridian.vessel}.`);
    expect(meridian.agent).not.toBe(meridian.vessel);
    expect(options.pathToClaudeCodeExecutable).toBe('/opt/claude');
    expect(options.outputFormat?.schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(options.env).toMatchObject({ CLAUDE_CONFIG_DIR: config.mindsDir, HOME: config.mindsDir, ANTHROPIC_CUSTOM_HEADERS: 'anthropic-workspace-id: wrkspc_test' });
    expect(Object.values(options.env ?? {})).not.toContain(process.env.GAZETTEER_PARENT_SECRET);
    const signal = new AbortController().signal;
    expect(await options.canUseTool?.('Bash', { command: 'ls' }, { signal, toolUseID: 'a' } as never)).toMatchObject({ behavior: 'deny' });
    expect(await options.canUseTool?.('mcp__ship__port_status', { port: 'singapore' }, { signal, toolUseID: 'b' } as never)).toMatchObject({ behavior: 'allow', updatedInput: { port: 'singapore' } });
  });
});

describe('the ship mind keeps its own voyage conversation', () => {
  test('a first call starts a session, the next one resumes it', async () => {
    const config = await configIn();
    const first = scripted([init('voyage-1'), decided('voyage-1', good)]);
    expect(await shipMind(first.run, config)(request(null))).toMatchObject({ status: 'ok', output: good, session: 'voyage-1' });
    expect(first.seen[0]?.resume).toBeUndefined();
    const second = scripted([init('voyage-1'), decided('voyage-1', good)]);
    await shipMind(second.run, config)(request('voyage-1'));
    expect(second.seen[0]?.resume).toBe('voyage-1');
  });
  test('an error result is a failure that keeps the session; a stream that dies before init forgets it', async () => {
    const config = await configIn();
    const errored = scripted([init('voyage-2'), { type: 'result', subtype: 'success', is_error: true, session_id: 'voyage-2', result: 'Invalid API key' }], new Error('Claude Code returned an error result'));
    expect(await shipMind(errored.run, config)(request('voyage-2'))).toEqual({ status: 'failed', message: expect.stringContaining('Invalid API key'), session: 'voyage-2' });
    const lost = scripted([], new Error('No conversation found with session ID'));
    expect(await shipMind(lost.run, config)(request('voyage-gone'))).toEqual({ status: 'failed', message: expect.stringContaining('No conversation found'), session: null });
  });
  test('a mind that does not answer in time is aborted into a failure', async () => {
    const config = await configIn(20);
    const run: MindQuery = ({ options }) => (async function* () {
      yield init('voyage-3');
      await new Promise(done => options.abortController?.signal.addEventListener('abort', done));
      throw new Error('aborted');
    })();
    expect(await shipMind(run, config)(request(null))).toMatchObject({ status: 'failed', message: expect.stringContaining('timed out'), session: 'voyage-3' });
  });
});

describe('what the mind saw', () => {
  test('port_status answers from the board and shows the bulletin id', () => {
    expect(answerTool(context, 'mcp__ship__port_status', { port: 'Singapore' })).toMatchObject({ body: { id: 'singapore', onMyRoute: true, bulletin }, ids: ['board-sg-7'] });
    expect(answerTool(context, 'mcp__ship__port_status', { port: 'atlantis' }).ids).toEqual([]);
    expect(answerTool(context, 'Bash', { command: 'ls' })).toEqual({ body: null, ids: [] });
  });
  test('only the tools the mind called count as shown', () => {
    const read = settleMind(context, { messages: [init('v'), used('v', 'mcp__ship__read_board'), decided('v', good)], error: null, timedOut: false });
    const blind = settleMind(context, { messages: [init('v'), used('v', 'mcp__ship__read_track'), decided('v', good)], error: null, timedOut: false });
    expect(read).toMatchObject({ status: 'ok', shown: ['board-sg-7'] });
    expect(blind).toMatchObject({ status: 'ok', shown: [] });
  });
});

describe('the actor drops what the mind was not shown', () => {
  const mindSaying = (output: unknown, shown: readonly string[]): AssessModel => async () => ({ status: 'ok', output, session: 'voyage-9', shown });
  const deps = (model: AssessModel) => ({ model, modelId: 'claude-haiku-5-5', now: () => at, session: null });
  test('an unshown citation is dropped, the shown ones and the session survive', async () => {
    const settled = await assessNotice(deps(mindSaying({ ...good, citedEvidence: ['sg-1', 'reuters-9'] }, [])), {}, meridian, notice);
    expect(settled.outcome).toMatchObject({ status: 'assessed', source: 'model' });
    expect(settled.shipment.assessments?.at(-1)?.citedEvidence).toEqual(['sg-1']);
    expect(settled.session).toBe('voyage-9');
  });
  test('an affecting decision left with no shown citation falls back', async () => {
    const settled = await assessNotice(deps(mindSaying({ ...good, citedEvidence: ['reuters-9'] }, [])), {}, meridian, notice);
    expect(settled.outcome).toMatchObject({ status: 'fallback', reason: expect.stringContaining('must cite evidence') });
  });
});

describe('the ship mind from the environment', () => {
  const never: MindQuery = () => { throw new Error('the mind must not start'); };
  test('no key is no mind; a key without its workspace id refuses before spawning', async () => {
    expect(shipMindFromEnv({}, never).model).toBeNull();
    const refused = shipMindFromEnv({ ANTHROPIC_API_KEY: 'k' }, never);
    expect(await refused.model?.(request(null))).toEqual({ status: 'failed', message: expect.stringContaining('ANTHROPIC_WORKSPACE_ID') });
  });
  test('a valid workspace id reaches the child as the custom header', async () => {
    const { run, seen } = scripted([init('v'), decided('v', good)]);
    const minds = await mkdtemp(join(tmpdir(), 'gazetteer-minds-'));
    const deps = shipMindFromEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_WORKSPACE_ID: 'wrkspc_abc123', GAZETTEER_MINDS_DIR: minds, PATH: '/usr/bin' }, run);
    await deps.model?.(request(null));
    expect(seen[0]?.env).toMatchObject({ ANTHROPIC_CUSTOM_HEADERS: 'anthropic-workspace-id: wrkspc_abc123', CLAUDE_CONFIG_DIR: minds });
  });
});

describe('the bounded mind pool', () => {
  const open = () => new AbortController().signal;
  test('never runs more than its size at once and starts calls in arrival order', async () => {
    const pool = boundedPool(2);
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const task = (id: number) => async () => {
      started.push(id);
      running += 1;
      peak = Math.max(peak, running);
      await new Promise(done => setTimeout(done, 5));
      running -= 1;
      return id;
    };
    const results = await Promise.all([1, 2, 3, 4, 5].map(id => pool(open(), task(id))));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
  });
  test('a call whose deadline passes in the queue never starts, and the queue moves on', async () => {
    const pool = boundedPool(1);
    let release: () => void = () => {};
    const holder = pool(open(), () => new Promise<string>(done => { release = () => done('held'); }));
    const late = new AbortController();
    let lateStarted = false;
    const queued = pool(late.signal, async () => { lateStarted = true; return 'late'; });
    const next = pool(open(), async () => 'next');
    late.abort();
    release();
    expect(await Promise.all([holder, queued, next])).toEqual(['held', null, 'next']);
    expect(lateStarted).toBe(false);
  });
  test('a mind call that expires in the queue fails as data and keeps its session', async () => {
    const config = await configIn(20);
    const busy = boundedPool(1);
    const blocker = busy(open(), () => new Promise(done => setTimeout(done, 100)));
    const { run, seen } = scripted([init('voyage-4'), decided('voyage-4', good)]);
    expect(await shipMind(run, config, busy)(request('voyage-4'))).toEqual({ status: 'failed', message: expect.stringContaining('deadline'), session: 'voyage-4' });
    expect(seen).toEqual([]);
    await blocker;
  });
});
