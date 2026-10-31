import { exposure, isActive } from '../src/server/sources/exposure';
import { lanes, places, sweep } from '../src/server/sources/poll';

const now = new Date();
const result = await sweep(now);
const laneSet = lanes(now);
const active = result.notices.filter(notice => isActive(notice, now));
const line = (text: string): void => console.log(text);

line(`Gazetteer live disruption probe @ ${now.toISOString()}`);
line(`feeds: ${result.notices.length} notices parsed, ${active.length} active; failures: ${result.failures.map(failure => `${failure.provider} (${failure.message})`).join('; ') || 'none'}`);
places.forEach(place => {
  const near = active.map(notice => ({ notice, found: exposure(notice, places, laneSet) })).filter(({ found }) => found.ports.some(hit => hit.portId === place.id));
  line(`\n${place.name}: ${near.length} notice(s) reach the port`);
  near.forEach(({ notice, found }) => {
    const hit = found.ports.find(candidate => candidate.portId === place.id);
    line(`  [${notice.severity}] ${notice.title} (${notice.provider}, ${notice.id})`);
    line(`      ${hit?.basis === 'declared-zone' ? 'inside declared forecast zone' : `${Math.round(hit?.distanceKm ?? 0)} km away, reach ${hit?.radiusKm} km`}; ${notice.url}`);
  });
});
line('\nSea lanes touched by active notices');
const touched = active.flatMap(notice => exposure(notice, places, laneSet).lanes.map(hit => ({ notice, hit })));
touched.forEach(({ notice, hit }) => line(`  ${hit.laneId} segment ${hit.segment}: ${notice.title} (${notice.provider}) ${Math.round(hit.distanceKm)} km off the track, reach ${hit.radiusKm} km`));
if (touched.length === 0) line('  none');
