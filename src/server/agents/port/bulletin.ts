import type { PortBulletin } from '../../../core/board';
import type { PortId } from '../../../core/ports';
import type { PortAssessment } from './risk';

const clip = (text: string, limit: number): string => text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
const sequence = (bulletin: PortBulletin | null): number => Number(bulletin?.id.match(/#(\d+)$/)?.[1] ?? 0);
export const bulletinId = (portId: PortId, previous: PortBulletin | null): string => `bulletin:${portId}#${sequence(previous) + 1}`;

const changed = (assessment: PortAssessment, previous: PortBulletin | null): boolean =>
  previous === null
    ? assessment.risk !== 'normal' || assessment.anchored > 0 || assessment.arrivals48h > 0
    : previous.risk !== assessment.risk || previous.anchored !== assessment.anchored || previous.arrivals48h !== assessment.arrivals48h;

const summaryOf = (assessment: PortAssessment, name: string): string =>
  clip(`${name} port risk ${assessment.risk}${assessment.reasons.length > 0 ? `: ${assessment.reasons.join('; ')}` : ': no live hazards, queue or arrivals due'}.`, 280);

/**
 * Posts only when the risk or a count changed, and nothing at all for a quiet port that has never said anything.
 * The id is the previous bulletin's sequence plus one, so a retry after a failed post carries the same id and Relay dedupes it,
 * while a later return to an earlier state is a new message.
 */
export const decideBulletin = (assessment: PortAssessment, previous: PortBulletin | null, name: string, now: Date): PortBulletin | null =>
  changed(assessment, previous) ? {
    id: bulletinId(assessment.portId, previous), kind: 'port.bulletin', author: { role: 'port', id: assessment.portId }, at: now.toISOString(),
    summary: summaryOf(assessment, name), portId: assessment.portId, risk: assessment.risk, anchored: assessment.anchored,
    arrivals48h: assessment.arrivals48h, evidenceIds: [...assessment.evidenceIds],
  } : null;
