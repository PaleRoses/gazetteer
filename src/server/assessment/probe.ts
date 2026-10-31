import { demoShipments } from '../../domain';
import { assessmentFromEnv, assessNotices, type AssessableNotice, type AssessmentCache } from '.';

const at = new Date().toISOString();
const notice: AssessableNotice = { id: 'sg-congestion-probe-1', portId: 'singapore', delayHours: 36, evidence: {
  id: 'sg-congestion-probe-1', source: 'simulation', title: 'Singapore berth congestion',
  detail: 'Simulated notice: container berth congestion at Singapore; vessels with scheduled calls queue for berth windows. The port agent estimates up to 36 hours of berth waiting. The strait remains open.', observedAt: at } };

const deps = assessmentFromEnv(process.env);
console.log(`model ${deps.modelId}, key ${deps.model ? 'present' : 'absent'}, workspace ${process.env.ANTHROPIC_WORKSPACE_ID ? 'set' : 'unset'}`);
const results = await Promise.all(demoShipments().map(async shipment => {
  const started = Date.now();
  const batch = await assessNotices(deps, {}, shipment, [notice]);
  return { id: shipment.id, wallMs: Date.now() - started, outcome: batch.outcomes[0], risk: batch.shipment.risk, delayHours: batch.shipment.delayHours, change: batch.shipment.change, record: batch.shipment.assessments?.[0], cache: batch.cache };
}));
results.forEach(({ cache: _cache, ...shown }) => console.log(JSON.stringify(shown, null, 1)));
const first = results[0]!;
const replay = await assessNotices(deps, first.cache as AssessmentCache, demoShipments()[0]!, [notice]);
console.log('replay from cache:', JSON.stringify(replay.outcomes), 'delayHours', replay.shipment.delayHours);
