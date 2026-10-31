import { createSdkMcpServer, tool, type CanUseTool, type Options } from '@anthropic-ai/claude-agent-sdk';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ports } from '../../core/ports';
import type { AssessDeps, AssessModel, MindContext, ModelRequest, ModelResult } from './assess';
import { assessmentModel, workspaceIdSchema } from './anthropic';
import { assessmentSchema } from './schema';

/** The SDK's `query`, narrowed to what the mind reads; the stream is parsed at this boundary, so a fake needs no SDK types. */
export type MindQuery = (params: Readonly<{ prompt: string; options: Options }>) => AsyncIterable<unknown>;
export type MindConfig = Readonly<{ apiKey: string; workspaceId: string; model: string; mindsDir: string; executable: string; path: string; timeoutMs: number }>;

const server = 'ship';
const shipTools = ['read_board', 'read_track', 'port_status'] as const;
type ShipTool = typeof shipTools[number];
const allowedShipTools: readonly string[] = shipTools.map(name => `mcp__${server}__${name}`);
const builtinTools: readonly string[] = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task', 'Agent', 'TodoWrite', 'Skill'];
const maxTurns = 4;
const mindTimeoutMs = 60_000;

const mindInstructions = [
  'You are the mind of this one ship. Your tools are your senses: read_board (what port and peer-ship agents posted that bears on your route),',
  'read_track (your own live telemetry window) and port_status (one port by id or name). Look before you decide, then return the decision as structured output.',
  'Cite only ids the input or your tools showed you.',
].join(' ');

type Answer = Readonly<{ body: unknown; ids: readonly string[] }>;
const portQuery = z.object({ port: z.string() });
const isShipTool = (name: string): name is ShipTool => (shipTools as readonly string[]).includes(name);
const unqualified = (name: string): string => name.startsWith(`mcp__${server}__`) ? name.slice(`mcp__${server}__`.length) : name;

const portStatus = (context: MindContext, input: unknown): Answer => {
  const asked = portQuery.safeParse(input);
  const port = asked.success ? ports.find(value => value.id === asked.data.port || value.name.toLowerCase() === asked.data.port.toLowerCase()) : undefined;
  if (!port) return { body: { found: false }, ids: [] };
  const bulletin = context.board.find(item => item.kind === 'port.bulletin' && item.facts.portId === port.id) ?? null;
  const ahead: readonly string[] = [...context.shipment.via, context.shipment.destination];
  return { body: { found: true, id: port.id, name: port.name, onMyRoute: ahead.includes(port.id), bulletin }, ids: bulletin ? [bulletin.id] : [] };
};

/** Pure: what each ship tool shows for this context, and the ids it showed. The stream's tool calls are replayed through it to know what the mind saw. */
export function answerTool(context: MindContext, name: string, input: unknown): Answer {
  const tool = unqualified(name);
  if (!isShipTool(tool)) return { body: null, ids: [] };
  switch (tool) {
    case 'read_board': return { body: context.board, ids: context.board.map(item => item.id) };
    case 'read_track': {
      const signals = context.observation?.signals ?? context.shipment.signals ?? [];
      return {
        body: { latest: context.shipment.telemetry ?? null, reading: context.observation?.reading ?? null, signals: signals.map(({ telemetry: _telemetry, ...signal }) => signal) },
        ids: signals.map(signal => signal.id),
      };
    }
    case 'port_status': return portStatus(context, input);
  }
}

const reply = (answer: Answer) => ({ content: [{ type: 'text' as const, text: JSON.stringify(answer.body) }] });
const shipServer = (context: MindContext) => createSdkMcpServer({
  name: server, version: '1.0.0',
  tools: [
    tool('read_board', 'Board messages from port and peer-ship agents that bear on my remaining route, by message id.', {}, async () => reply(answerTool(context, 'read_board', {}))),
    tool('read_track', 'My own live telemetry window: the latest position report, the watcher reading and the signals it raised.', {}, async () => reply(answerTool(context, 'read_track', {}))),
    tool('port_status', 'One port by id or name: whether it is on my remaining route and its newest bulletin on the board.', { port: z.string() }, async args => reply(answerTool(context, 'port_status', args))),
  ],
});

const denyForeign: CanUseTool = async (name, input) =>
  allowedShipTools.includes(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: `${name} is not one of this ship's tools` };

/** The child sees only this environment: its home and config are the minds directory, never the user's ~/.claude. */
const mindEnv = (config: MindConfig): Readonly<Record<string, string>> => ({
  PATH: config.path, HOME: config.mindsDir, CLAUDE_CONFIG_DIR: config.mindsDir,
  ANTHROPIC_API_KEY: config.apiKey, ANTHROPIC_CUSTOM_HEADERS: `anthropic-workspace-id: ${config.workspaceId}`,
  CLAUDE_AGENT_SDK_CLIENT_APP: 'gazetteer-ship-mind/1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1',
});

/** Draft 7: the CLI's validator does not load the 2020-12 meta-schema zod emits by default. */
const decisionSchema = z.toJSONSchema(assessmentSchema, { target: 'draft-7' }) as Record<string, unknown>;

const mindOptions = (config: MindConfig, request: ModelRequest, abortController: AbortController): Options => ({
  model: config.model, systemPrompt: `${request.system}\n${mindInstructions}`,
  tools: [], allowedTools: [...allowedShipTools], disallowedTools: [...builtinTools], canUseTool: denyForeign,
  settingSources: [], strictMcpConfig: true, mcpServers: { [server]: shipServer(request.context) },
  maxTurns, persistSession: true, cwd: config.mindsDir, env: { ...mindEnv(config) }, abortController, pathToClaudeCodeExecutable: config.executable,
  outputFormat: { type: 'json_schema', schema: decisionSchema },
  ...(request.session ? { resume: request.session } : {}),
});

const block = z.object({ type: z.string(), name: z.string().optional(), input: z.unknown().optional() });
const streamMessage = z.union([
  z.object({ type: z.literal('system'), subtype: z.literal('init'), session_id: z.string() }),
  z.object({ type: z.literal('assistant'), session_id: z.string(), message: z.object({ content: z.array(block) }) }),
  z.object({ type: z.literal('result'), subtype: z.string(), is_error: z.boolean(), session_id: z.string(), structured_output: z.unknown().optional(), result: z.string().optional(), errors: z.array(z.string()).optional() }),
]);
type StreamMessage = z.infer<typeof streamMessage>;
export type Drained = Readonly<{ messages: readonly unknown[]; error: string | null; timedOut: boolean }>;

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Total: the SDK throws after an error result, so the messages read before the throw are kept with it. */
const drain = async (stream: AsyncIterator<unknown>, read: readonly unknown[]): Promise<Readonly<{ messages: readonly unknown[]; error: string | null }>> => {
  try {
    const next = await stream.next();
    return next.done ? { messages: read, error: null } : drain(stream, [...read, next.value]);
  } catch (error) {
    return { messages: read, error: messageOf(error) };
  }
};

/** Pure: the mind's stream becomes the model contract plus the session to resume and the ids its tools showed. */
export function settleMind(context: MindContext, { messages, error, timedOut }: Drained): ModelResult {
  const parsed = messages.flatMap((message): StreamMessage[] => { const value = streamMessage.safeParse(message); return value.success ? [value.data] : []; });
  const session = parsed.find(message => message.type === 'system')?.session_id ?? parsed.at(-1)?.session_id ?? null;
  const shown = [...new Set(parsed.flatMap(message => message.type === 'assistant'
    ? message.message.content.flatMap(item => item.type === 'tool_use' && item.name ? answerTool(context, item.name, item.input).ids : [])
    : []))];
  const result = parsed.find(message => message.type === 'result');
  if (result?.type === 'result' && !result.is_error && result.structured_output !== undefined) return { status: 'ok', output: result.structured_output, session, shown };
  const reason = timedOut ? 'ship mind timed out'
    : result?.type === 'result' ? `ship mind ${result.is_error ? 'error' : result.subtype}: ${result.result || result.errors?.join('; ') || 'no decision'}`
    : error ?? 'ship mind ended without a decision';
  return { status: 'failed', message: reason, session };
}

/** The effect edge: one SDK query per situation, resumed from the ship's own session, bounded in time. */
export const shipMind = (run: MindQuery, config: MindConfig): AssessModel => async request => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), config.timeoutMs);
  const drained = await mkdir(config.mindsDir, { recursive: true, mode: 0o700 })
    .then(() => drain(run({ prompt: request.prompt, options: mindOptions(config, request, abort) })[Symbol.asyncIterator](), []))
    .catch((error: unknown) => ({ messages: [], error: messageOf(error) }));
  clearTimeout(timer);
  return settleMind(request.context, { ...drained, timedOut: abort.signal.aborted });
};

const mindsDirOf = (env: Readonly<Record<string, string | undefined>>): string =>
  resolve(env.GAZETTEER_MINDS_DIR ?? resolve(env.DATA_DIR ?? '.data', 'actors', 'minds'));

/** Terse bundles the actor, so the SDK cannot find its platform binary from its own module URL: the actor's cwd is the project, resolve it from there. */
const claudeExecutableOf = (env: Readonly<Record<string, string | undefined>>): string =>
  resolve(env.GAZETTEER_CLAUDE_EXECUTABLE ?? resolve('node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude'));

const refuse = (message: string): AssessModel => async () => ({ status: 'failed', message });

/** Thin env edge: no key means no mind (the deterministic fallback); a key without its workspace id refuses before spawning anything. */
export const shipMindFromEnv = (env: Readonly<Record<string, string | undefined>>, run: MindQuery): AssessDeps => {
  const modelId = env.GAZETTEER_ASSESSMENT_MODEL || assessmentModel;
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return { model: null, modelId };
  const workspace = workspaceIdSchema.safeParse(env.ANTHROPIC_WORKSPACE_ID);
  if (!workspace.success) return { model: refuse(env.ANTHROPIC_WORKSPACE_ID ? workspace.error.issues[0]?.message ?? 'invalid workspace id' : 'ANTHROPIC_WORKSPACE_ID is not set; the ship mind needs it'), modelId };
  return { model: shipMind(run, { apiKey, workspaceId: workspace.data, model: modelId, mindsDir: mindsDirOf(env), executable: claudeExecutableOf(env), path: env.PATH ?? '', timeoutMs: mindTimeoutMs }), modelId };
};
