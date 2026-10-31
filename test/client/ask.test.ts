import { describe, expect, test } from 'bun:test';
import { askAnswerSchema, askOutcome } from '../../src/client/ask';

describe('asking a ship mind', () => {
  test('an answer carries the ids it cites', () => {
    expect(askOutcome('Why late?', { ok: true, value: { answer: 'Rotterdam queue.', cited: ['b-1'], mind: 'Vega' } })).toEqual({ state: 'answered', question: 'Why late?', answer: 'Rotterdam queue.', cited: ['b-1'], mind: 'Vega' });
  });

  test('a 503 is the mind unavailable; any other failure is the request failing', () => {
    expect(askOutcome('q', { ok: false, status: 503, error: 'The ship mind is unavailable.' }).state).toBe('unavailable');
    expect(askOutcome('q', { ok: false, status: 0, error: 'Cannot reach the workspace.' }).state).toBe('failed');
    expect(askOutcome('q', { ok: false, status: 404, error: 'Not found' }).state).toBe('failed');
  });

  test('the route answer parses; an empty answer does not', () => {
    expect(askAnswerSchema.safeParse({ answer: 'ok', cited: [], mind: 'Vega', session: null }).success).toBe(true);
    expect(askAnswerSchema.safeParse({ answer: '', cited: [], mind: 'Vega' }).success).toBe(false);
    expect(askAnswerSchema.safeParse({ answer: 'ok', mind: 'Vega' }).success).toBe(false);
  });
});
