import { describe, expect, test } from 'bun:test';
import type { BoardMessage } from '../../../../src/core/board';
import { demoScenarios } from '../../../../src/server/telemetry/simulation';
import { runSociety } from '../../../society-run';

const numbers = (text: string): readonly string[] => text.match(/\d+(?:\.\d+)?/g) ?? [];

/** A number in a ship's own summary must be one the message itself carries in another field; constants appear as words, and AI prose is the model's, labelled as such. */
const unexplained = (message: BoardMessage): readonly string[] => {
  const { summary, ...rest } = message;
  const known = new Set(numbers(JSON.stringify(rest)));
  return numbers(summary).filter(token => !known.has(token));
};

describe('ship voice', () => {
  test('every number in a ship summary is one of the message\'s own fields, and no summary outruns the board', async () => {
    const { board } = await runSociety();
    const spoken = board.filter(message => message.author.role === 'ship' && !(message.kind === 'ship.assessment' && message.method !== 'rule-based'));
    expect(spoken.length).toBeGreaterThan(0);
    spoken.forEach(message => {
      expect(unexplained(message)).toEqual([]);
      expect(message.summary.length).toBeLessThanOrEqual(280);
    });
    expect(Object.keys(demoScenarios).length).toBeGreaterThan(0);
  });

  test('the check can fail: a number the message does not carry is caught', () => {
    const message = { id: 'x', kind: 'ship.eta', author: { role: 'ship', id: 's', vessel: 'v' }, at: '2026-10-31T12:00:00.000Z', summary: 'v expects 77 ships', shipmentId: 's', portId: 'singapore', eta: '2026-10-31T12:00:00.000Z', previousEta: '2026-10-31T12:00:00.000Z' } as BoardMessage;
    expect(unexplained(message)).toEqual(['77']);
  });
});
