import { mkdir } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createAccess } from './access/access';
import { createApi } from './http/api';
import { startIngest } from './runtime/ingest';
import { createMonitoring } from './runtime/monitoring';
import { readStartupConfig } from './config';

const configuration = readStartupConfig(process.env, Bun.version);
if (!configuration.ok) {
  console.error(configuration.errors.join('\n'));
  process.exit(1);
}
const { port, hostname, origin, mail } = configuration.value;
const dataDir = resolve(configuration.value.dataDir);
const assets = resolve('dist');
if (!await Bun.file(resolve(assets, 'index.html')).exists()) {
  console.error('Gazetteer frontend is not built. Run npm run build, then npm start.');
  process.exit(1);
}
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const access = createAccess(resolve(dataDir, 'access.sqlite'));
const monitoring = await createMonitoring({ dataDir: resolve(dataDir, 'actors'), workspaceIds: access.workspaceIds(), hasWorkspace: workspaceId => access.workspaceIds().includes(workspaceId) });
/** The live AIS firehose: one reader for the whole process. GAZETTEER_INGEST=off turns it off. */
const ingest = process.env.GAZETTEER_INGEST === 'off' ? undefined : startIngest();
const api = createApi({ access, monitoring, origin, mail: mail.kind === 'resend' ? mail : undefined });

const server = Bun.serve({
  port, hostname, maxRequestBodySize: 16384, idleTimeout: 120,
  fetch: async (request, server) => {
    const path = new URL(request.url).pathname;
    if (path === '/api/ingest/status' && request.method === 'GET') return Response.json(ingest ? ingest.status() : { running: false });
    if (path.startsWith('/api/')) return api(request, server.requestIP(request)?.address ?? 'unknown');
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const target = resolve(assets, `.${decodeURIComponent(path)}`);
    if (target !== assets && !target.startsWith(`${assets}${sep}`)) return new Response('Not found', { status: 404 });
    const file = Bun.file(target);
    const responseFile = path !== '/' && await file.exists() ? file : Bun.file(resolve(assets, 'index.html'));
    return new Response(responseFile, { headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" } });
  },
  error: error => {
    console.error(error instanceof Error ? error.message : 'Request failed');
    return Response.json({ error: 'Service unavailable. Please retry.' }, { status: 503 });
  },
});
console.info(`Gazetteer: ${origin} (synthetic demo data)`);
console.info(mail.kind === 'manual' ? 'Invitations: manual share links; email is not configured.' : 'Invitations: email provider configured; delivery requires a provider receipt.');
const close = async (): Promise<void> => { await server.stop(true); access.close(); await monitoring.close(); await ingest?.close(); process.exit(0); };
process.once('SIGINT', close);
process.once('SIGTERM', close);
