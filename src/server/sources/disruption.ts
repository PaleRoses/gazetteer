import type { Disruption } from '../../shared';
import { distanceKm } from './geo';
import { evidenceLine, radiusKm } from './exposure';
import { places, type PortNotice } from './index';
import type { Notice } from './notice';

type Circle = NonNullable<Disruption['geometry']>;

/** The assessor's pre-filter reads circles: a point with its declared reach, a bbox as the circle that holds it plus that reach. Zones carry no coordinates. */
export const circleOf = (notice: Notice): Circle | undefined => {
  const { geometry } = notice;
  switch (geometry.kind) {
    case 'point': return { center: geometry.coordinates, radiusKm: radiusKm[notice.kind] };
    case 'bbox': {
      const center: Circle['center'] = [(geometry.west + geometry.east) / 2, (geometry.south + geometry.north) / 2];
      return { center, radiusKm: radiusKm[notice.kind] + distanceKm(center, [geometry.east, geometry.north]) };
    }
    case 'zone': return undefined;
  }
};

/** A live notice as a Disruption. A lane-only notice has one id whichever port reports it, so the relay and the shipments dedupe it even if the nearest port changes. The delay is null on purpose: no feed states one, and inventing it is the assessor's job, never ours. */
export const toDisruption = ({ notice, hit, lanes }: PortNotice): Disruption => {
  const name = places.find(place => place.id === hit.portId)?.name ?? hit.portId;
  const geometry = circleOf(notice);
  return {
    id: `${notice.id}@${hit.basis === 'nearest-to-lane' ? 'lane' : hit.portId}`, portId: hit.portId, scope: hit.basis === 'nearest-to-lane' ? 'lane' : 'port', delayHours: null,
    evidence: {
      id: notice.id, source: 'live', provider: notice.provider, url: notice.url, title: notice.title,
      detail: `${notice.detail} ${evidenceLine(hit, name, lanes)}`.trim(), observedAt: notice.observedAt,
    },
    ...(geometry === undefined ? {} : { geometry }),
  };
};
