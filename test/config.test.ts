import { describe, expect, test } from 'bun:test';
import { readStartupConfig, relaySetupStatus } from '../src/server/config';

const runtime = '1.4.4';

describe('startup configuration', () => {
  test('uses local defaults with honest manual invitation mode', () => {
    expect(readStartupConfig({}, runtime)).toEqual({ ok: true, value: {
      port: 4310, hostname: '127.0.0.1', origin: 'http://localhost:4310', dataDir: '.data', mail: { kind: 'manual' },
    } });
  });

  test('normalizes a reachable origin and configured mail without claiming delivery', () => {
    expect(readStartupConfig({ PORT: '8080', HOST: '0.0.0.0', APP_ORIGIN: 'https://demo.example/', DATA_DIR: '/data', RESEND_API_KEY: 'example-key', MAIL_FROM: 'Gazetteer <demo@example.com>' }, runtime)).toEqual({ ok: true, value: {
      port: 8080, hostname: '0.0.0.0', origin: 'https://demo.example', dataDir: '/data', mail: { kind: 'resend', key: 'example-key', from: 'Gazetteer <demo@example.com>' },
    } });
  });

  test.each(['', '0', '-1', '65536', '4310.5', 'NaN'])('rejects invalid PORT %j', port => {
    expect(readStartupConfig({ PORT: port }, runtime).ok).toBe(false);
  });

  test.each(['not-a-url', 'ftp://demo.example', 'https://demo.example/path', 'https://demo.example?invite=x', 'https://demo.example#fragment', 'https://user:password@demo.example'])('rejects non-origin APP_ORIGIN %j', origin => {
    expect(readStartupConfig({ APP_ORIGIN: origin }, runtime).ok).toBe(false);
  });

  test('rejects partial email configuration and never echoes credentials', () => {
    const keyOnly = readStartupConfig({ RESEND_API_KEY: 'do-not-print-this-key' }, runtime);
    expect(keyOnly.ok).toBe(false);
    expect(JSON.stringify(keyOnly)).not.toContain('do-not-print-this-key');
    expect(readStartupConfig({ MAIL_FROM: 'sender@example.com' }, runtime).ok).toBe(false);
    expect(readStartupConfig({ RESEND_API_KEY: ' ', MAIL_FROM: '' }, runtime).ok).toBe(true);
  });

  test('enforces the real actor runtime minimum', () => {
    expect(readStartupConfig({}, '1.3.14').ok).toBe(false);
    expect(readStartupConfig({}, '1.4.1').ok).toBe(false);
    expect(readStartupConfig({}, '1.4.2').ok).toBe(true);
    expect(readStartupConfig({}, '1.5.0').ok).toBe(true);
    expect(readStartupConfig({}, '2.0.0').ok).toBe(true);
  });
});

describe('Relay setup safety', () => {
  test('preserves configured credentials and refuses empty declarations', () => {
    expect(relaySetupStatus('existing-key', '')).toBe('configured');
    expect(relaySetupStatus('', 'RELAY_WORKSPACE_KEY=\n')).toBe('empty');
    expect(relaySetupStatus('  ', '')).toBe('empty');
    expect(relaySetupStatus(undefined, 'export RELAY_WORKSPACE_KEY=""\n')).toBe('empty');
    expect(relaySetupStatus(undefined, '# RELAY_WORKSPACE_KEY=\n')).toBe('missing');
  });
});
