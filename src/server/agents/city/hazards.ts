import { hazardReport, type HazardNotice, type HazardReport, type PortRisk } from '../../../core/board';
import { portById, type PortId } from '../../../core/ports';
import type { PortNotice } from '../../sources/poll';
import type { NoticeSeverity } from '../../sources/notice';
import { clip, heartbeat, reportId } from './report';

type Level = 0 | 1 | 2;
const riskOf = (level: Level): PortRisk => (['normal', 'elevated', 'severe'] as const)[level];
const severityRank: Readonly<Record<NoticeSeverity, number>> = { minor: 0, moderate: 1, severe: 2, extreme: 3 };

/**
 * A live notice's level. Its severity sets the rank (minor 0, moderate 1, severe 2, extreme 3), and one step is taken off when it
 * does not sit squarely on the city: beyond half its declared reach, or only crossing a sea lane. A minor notice never raises the
 * risk, so a routine marine weather statement leaves the city normal.
 */
export const noticeLevel = ({ notice, hit }: PortNotice): Level => {
  const squarely = hit.basis === 'declared-zone' || (hit.basis === 'distance' && hit.distanceKm <= hit.radiusKm / 2);
  return Math.min(2, Math.max(0, severityRank[notice.severity] - (squarely ? 0 : 1))) as Level;
};

export type HazardAssessment = Readonly<{ city: PortId; risk: PortRisk; notices: readonly HazardNotice[]; evidenceIds: readonly string[] }>;

const hazardShape = hazardReport.shape.notices.element.shape;
/** Security reports widen the runtime's notice type but never reach a city watch; only the hazard providers and kinds the board protocol carries count. */
const isHazard = (entry: PortNotice): entry is PortNotice & Readonly<{ notice: Readonly<{ provider: HazardNotice['provider']; kind: HazardNotice['kind'] }> }> =>
  hazardShape.provider.safeParse(entry.notice.provider).success && hazardShape.kind.safeParse(entry.notice.kind).success;

/** The worst notice sets the risk and is the evidence; every notice reaching the city is listed with its provider, link and fetch time. */
export const assessHazards = (city: PortId, reaching: readonly PortNotice[]): HazardAssessment => {
  const graded = reaching.filter(isHazard).map(entry => ({ notice: entry.notice, level: noticeLevel(entry) }));
  const level = Math.max(0, ...graded.map(item => item.level)) as Level;
  return {
    city, risk: riskOf(level),
    notices: graded.map(({ notice }) => ({ id: notice.id, provider: notice.provider, kind: notice.kind, severity: notice.severity, title: notice.title, url: notice.url, fetchedAt: notice.fetchedAt })),
    evidenceIds: level > 0 ? graded.filter(item => item.level === level).map(item => item.notice.id) : [],
  };
};

const sameNotices = (left: readonly HazardNotice[], right: readonly HazardNotice[]): boolean =>
  left.length === right.length && left.every(notice => right.some(other => other.id === notice.id));

const changed = (assessment: HazardAssessment, previous: HazardReport | null): boolean =>
  previous === null
    ? assessment.risk !== 'normal' || assessment.notices.length > 0
    : previous.risk !== assessment.risk || !sameNotices(previous.notices, assessment.notices);

/** Data first and no count the message does not carry: the notice that set the risk, or why nothing did. */
const reason = (assessment: HazardAssessment): string => {
  const worst = assessment.notices.find(notice => notice.id === assessment.evidenceIds[0]);
  return worst ? `set by a ${worst.severity} ${worst.kind}, ${worst.title}`
    : assessment.notices.length > 0 ? 'the live notices in force are minor or off the city' : 'no live notice in force';
};

/** Posts on a change of risk or of the notices in force, or on a heartbeat; a quiet city that has never said anything stays silent. */
export const decideHazards = (assessment: HazardAssessment, previous: HazardReport | null, now: Date): HazardReport | null => {
  if (!changed(assessment, previous) && !heartbeat(previous, assessment.risk, now)) return null;
  const place = portById.get(assessment.city);
  return place ? {
    id: reportId(assessment.city, 'hazards', previous), kind: 'city.hazards', author: { role: 'city', city: assessment.city, element: 'hazards' },
    at: now.toISOString(),
    summary: clip(`${place.name} hazard watch: ${assessment.risk}, ${reason(assessment)}.`),
    risk: assessment.risk, notices: [...assessment.notices], evidenceIds: [...assessment.evidenceIds],
  } : null;
};
