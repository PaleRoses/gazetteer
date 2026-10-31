import { telemetrySourceFromEnv } from './source';

const mmsis = process.argv.slice(2);
const source = telemetrySourceFromEnv(process.env);
console.log(`provider chain: ${process.env.AISSTREAM_API_KEY ? 'aisstream then ' : ''}digitraffic`);
for (const mmsi of mmsis.length ? mmsis : ['273251360', '538010578', '230098780']) {
  const outcome = await source(mmsi);
  console.log(mmsi, JSON.stringify(outcome));
}
process.exit(0);
