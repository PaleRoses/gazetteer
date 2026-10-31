import { expect, test } from 'bun:test';
import { readView, viewHash } from '../../src/client/navigation';

test('simulation is bookmarkable and scoped to its workspace', () => {
  const view = { kind: 'simulation' } as const;
  const hash = viewHash(view, 'workspace one');
  expect(readView(hash, 'workspace one')).toEqual(view);
  expect(readView(hash, 'different workspace')).toEqual({ kind: 'shipments' });
});
