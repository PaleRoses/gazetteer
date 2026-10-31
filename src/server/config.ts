import { z } from 'zod';

type MailConfiguration =
  | Readonly<{ kind: 'manual' }>
  | Readonly<{ kind: 'resend'; key: string; from: string }>;

type StartupConfiguration = Readonly<{
  port: number;
  hostname: string;
  origin: string;
  dataDir: string;
  mail: MailConfiguration;
  /** `off` (the default): the board is a local log and Agent Relay is never called. `mirror`: actors also join Relay in the background and their posts are mirrored to it. */
  relay: 'off' | 'mirror';
}>;

export type ConfigurationResult =
  | Readonly<{ ok: true; value: StartupConfiguration }>
  | Readonly<{ ok: false; errors: readonly string[] }>;

type Environment = Readonly<Record<string, string | undefined>>;
const optionalText = z.preprocess(value => typeof value === 'string' && value.trim() === '' ? undefined : value, z.string().trim().optional());
const isOrigin = (value: string): boolean => {
  const url = URL.parse(value);
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:') && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '';
};
const environmentSchema = z.object({
  PORT: z.string().regex(/^\d+$/, 'PORT must be an integer from 1 to 65535.').transform(Number).pipe(z.number().int().min(1).max(65535)).default(4310),
  HOST: z.string().trim().min(1, 'HOST must not be empty.').default('127.0.0.1'),
  APP_ORIGIN: z.string().trim().refine(isOrigin, 'APP_ORIGIN must be an HTTP(S) origin without credentials, a path, query, or fragment.').optional(),
  DATA_DIR: z.string().trim().min(1, 'DATA_DIR must not be empty.').default('.data'),
  RESEND_API_KEY: optionalText,
  MAIL_FROM: optionalText,
  GAZETTEER_RELAY: z.enum(['off', 'mirror'], 'GAZETTEER_RELAY must be off or mirror.').default('off'),
});

const supportsActors = (version: string): boolean => {
  const [major, minor, patch] = version.split('.').map(Number);
  return major > 1 || (major === 1 && (minor > 4 || (minor === 4 && patch >= 2)));
};

/** Configuration validation is pure; no credentials are included in diagnostics. */
export function readStartupConfig(environment: Environment, runtimeVersion: string): ConfigurationResult {
  if (!supportsActors(runtimeVersion)) return { ok: false, errors: ['Gazetteer requires Bun 1.4.2 or newer. Install dependencies, then use npm start to run the pinned Bun runtime.'] };
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) };
  const { PORT: port, HOST: hostname, APP_ORIGIN: origin, DATA_DIR: dataDir, RESEND_API_KEY: key, MAIL_FROM: from, GAZETTEER_RELAY: relay } = parsed.data;
  if (Boolean(key) !== Boolean(from)) return { ok: false, errors: ['Email delivery requires both RESEND_API_KEY and MAIL_FROM. Configure both, or remove both to use manual invitation links.'] };
  return {
    ok: true,
    value: {
      port, hostname, origin: origin ? new URL(origin).origin : `http://localhost:${port}`, dataDir,
      mail: key && from ? { kind: 'resend', key, from } : { kind: 'manual' }, relay,
    },
  };
}

export type RelaySetupStatus = 'configured' | 'empty' | 'missing';
export const relaySetupStatus = (key: string | undefined, environmentFile: string): RelaySetupStatus =>
  key?.trim() ? 'configured' : key !== undefined || /^\s*(?:export\s+)?RELAY_WORKSPACE_KEY\s*=/m.test(environmentFile) ? 'empty' : 'missing';
