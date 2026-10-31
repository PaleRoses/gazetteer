import { chmod, readFile, writeFile } from 'node:fs/promises';
import { AgentRelay } from '@agent-relay/sdk';
import { relaySetupStatus } from '../src/server/config';

const environment = await readFile('.env', 'utf8').catch((error: unknown) => {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '';
  throw error;
});
const status = relaySetupStatus(process.env.RELAY_WORKSPACE_KEY, environment);
if (status === 'configured') {
  console.info('Agent Relay is already configured. Existing credentials preserved.');
} else if (status === 'empty') {
  console.error('RELAY_WORKSPACE_KEY is empty. Set an existing workspace key, or remove the empty declaration before running setup:relay to create a new workspace. No workspace was created.');
  process.exitCode = 1;
} else {
  const relay = await AgentRelay.createWorkspace({ name: 'Gazetteer demo' });
  if (!relay.workspaceKey) throw new Error('Agent Relay did not return a workspace key.');
  await writeFile('.env', `${environment}${environment.endsWith('\n') || environment === '' ? '' : '\n'}RELAY_WORKSPACE_KEY=${relay.workspaceKey}\n`, { mode: 0o600 });
  await chmod('.env', 0o600);
  console.info('Private demo Relay workspace configured. Credentials saved locally; no live shipment data is connected.');
}
