import { chmod, readFile, writeFile } from 'node:fs/promises';
import { AgentRelay } from '@agent-relay/sdk';

const environment = await readFile('.env', 'utf8').catch(() => '');
if (process.env.RELAY_WORKSPACE_KEY || /^RELAY_WORKSPACE_KEY=/m.test(environment)) {
  console.info('Agent Relay is already configured. Existing credentials preserved.');
} else {
  const relay = await AgentRelay.createWorkspace({ name: 'Gazetteer demo' });
  if (!relay.workspaceKey) throw new Error('Agent Relay did not return a workspace key.');
  await writeFile('.env', `${environment}${environment.endsWith('\n') || environment === '' ? '' : '\n'}RELAY_WORKSPACE_KEY=${relay.workspaceKey}\n`, { mode: 0o600 });
  await chmod('.env', 0o600);
  console.info('Private demo Relay workspace configured. Credentials saved locally; no live shipment data is connected.');
}
