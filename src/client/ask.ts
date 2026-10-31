import { z } from 'zod';
import type { ApiResult } from './api';

export const askAnswerSchema = z.object({ answer: z.string().min(1), cited: z.array(z.string()), mind: z.string().min(1) });
type AskAnswer = z.infer<typeof askAnswerSchema>;

export type AskState =
  | Readonly<{ state: 'idle' }>
  | Readonly<{ state: 'asking'; question: string }>
  | Readonly<{ state: 'answered'; question: string; answer: string; cited: readonly string[]; mind: string }>
  | Readonly<{ state: 'unavailable'; question: string; message: string }>
  | Readonly<{ state: 'failed'; question: string; message: string }>;

/** A 503 is the mind being away, which is its own state; any other failure is the request failing. */
export const askOutcome = (question: string, result: ApiResult<AskAnswer>): AskState => {
  if (result.ok) return { state: 'answered', question, answer: result.value.answer, cited: result.value.cited, mind: result.value.mind };
  return result.status === 503 ? { state: 'unavailable', question, message: result.error } : { state: 'failed', question, message: result.error };
};
