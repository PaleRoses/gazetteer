import { readFile, writeFile } from 'node:fs/promises';

const parse = (text: string): Date | null => {
  const ms = Number(text.trim());
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
};

/**
 * The instant the demo scenario is dated from. It is written once, exclusively, and read back by every later process on the same
 * data directory, so a restart re-derives the same seed ETAs the persisted actors already hold instead of re-anchoring the fleet to "now".
 */
export async function scenarioEpoch(file: string, now: () => number = Date.now): Promise<Date> {
  const held = await readFile(file, 'utf8').then(parse, () => null);
  if (held) return held;
  const fresh = String(now());
  const won = await writeFile(file, fresh, { flag: 'wx', mode: 0o600 }).then(() => true, () => false);
  return won ? new Date(Number(fresh)) : (await readFile(file, 'utf8').then(parse, () => null)) ?? new Date(Number(fresh));
}
