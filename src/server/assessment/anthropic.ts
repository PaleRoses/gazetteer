import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import type { AssessDeps, AssessModel } from './assess';
import { assessmentSchema } from './schema';

export const assessmentModel = 'claude-haiku-5-5';
export const alternativeAssessmentModel = 'claude-sonnet-5-5';
const maxTokens = 1024;
const timeoutMs = 30_000;

export const anthropicModel = (apiKey: string, model: string, workspaceId?: string): AssessModel => {
  const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1, ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}) });
  const format = zodOutputFormat(assessmentSchema);
  return async ({ system, prompt }) => {
    try {
      const reply = await client.messages.create({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }], output_config: { format } });
      const text = reply.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
      if (!text) return { status: 'failed', message: `no structured output (stop_reason ${reply.stop_reason})` };
      return { status: 'ok', output: JSON.parse(text) as unknown };
    } catch (error) {
      return { status: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
  };
};

/** Thin env edge: no ANTHROPIC_API_KEY means no model, which the pipeline reports as a deterministic fallback. */
export const workspaceIdSchema = z.string().regex(/^wrkspc_[A-Za-z0-9]+$/, 'ANTHROPIC_WORKSPACE_ID must be a wrkspc_ id');

export const assessmentFromEnv = (env: Readonly<Record<string, string | undefined>>): AssessDeps => {
  const modelId = env.GAZETTEER_ASSESSMENT_MODEL || assessmentModel;
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return { model: null, modelId };
  if (!env.ANTHROPIC_WORKSPACE_ID) return { model: anthropicModel(key, modelId), modelId };
  const workspace = workspaceIdSchema.safeParse(env.ANTHROPIC_WORKSPACE_ID);
  return { model: workspace.success ? anthropicModel(key, modelId, workspace.data) : async () => ({ status: 'failed', message: workspace.error.issues[0]?.message ?? 'invalid workspace id' }), modelId };
};
