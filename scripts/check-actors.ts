// Terse's actor build type-checks the actors' public surface with nodenext: relative imports reachable from actor signatures need explicit .js.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startLocalActors } from 'durable-actors/dev';

const dataDir = await mkdtemp(join(tmpdir(), 'gazetteer-actors-'));
const outcome = await startLocalActors({ project: resolve(import.meta.dir, '..'), projectId: 'gazetteer-check', entrypoint: 'src/server/agents/index.ts', dataDir, apiKey: crypto.randomUUID(), quiet: true })
  .then(runtime => runtime.stop().then(() => null), (error: unknown) => (error instanceof Error ? error.message : String(error)));
await rm(dataDir, { recursive: true, force: true });
if (outcome !== null) console.error(`actor build failed: ${outcome}`);
process.exit(outcome === null ? 0 : 1);
