import type { ShipAssessment, ShipObservation } from '../../../core/board';
import { portById, type PortId } from '../../../core/ports';

const limit = 280;
/** A summary is data first and never longer than the board allows; a cut one says so. */
export const clip = (text: string): string => text.length <= limit ? text : `${text.slice(0, limit - 3)}...`;

const portName = (id: PortId): string => portById.get(id)?.name ?? id;
const utc = (instant: string): string => `${instant.slice(0, 10)} ${instant.slice(11, 16)}Z`;
const readings: Readonly<Record<string, string>> = {
  sogKnots: 'kn over ground', nearestPortKm: 'km from the nearest port', loiteringHours: 'h loitering', offRouteKm: 'km off the planned route',
  silentHours: 'h without a position report', impliedKnots: 'kn needed for the ETA', projectedSlipHours: 'h projected slip',
};

/** Every number in a ship's own summary is read from the message it summarises; constants appear only as words. */
const opening = (agent: string, vessel: string): string => `${agent}, aboard ${vessel}`;

export const observationSummary = (agent: string, vessel: string, titles: readonly string[], measured: NonNullable<ShipObservation['measured']>, nearPort: PortId | null): string =>
  clip(`${opening(agent, vessel)}: ${titles.join('; ')}${nearPort ? ` near ${portName(nearPort)}` : ''}. ${Object.entries(readings).flatMap(([key, label]) => {
    const value = measured[key];
    return typeof value === 'number' ? [`${value} ${label}`] : [];
  }).join(', ')}.`.replace(/ \.$/, '.'));

export const ruleAssessmentSummary = (agent: string, vessel: string, message: Pick<ShipAssessment, 'risk' | 'eta' | 'delayHours' | 'basis'>, reasons: readonly string[]): string =>
  clip(`${opening(agent, vessel)}, by rule: ${message.risk}. ${reasons.join('; ')}.${message.basis ? ` ${message.basis.anchored} anchored at ${portName(message.basis.portId)}, ${message.delayHours?.likely ?? 0} h likely queue delay.` : ''} ETA ${utc(message.eta)}.`);

export const etaSummary = (agent: string, vessel: string, portId: PortId, eta: string, previousEta: string): string =>
  clip(`${opening(agent, vessel)} expects ${portName(portId)} at ${utc(eta)}${eta === previousEta ? '' : `, from ${utc(previousEta)}`}.`);

/** The ship introduces what its model, or the arithmetic fallback, concluded; the prose after the colon is the model's own and is labelled by the assessment's method. */
export const assessedSummary = (agent: string, vessel: string, message: Pick<ShipAssessment, 'risk' | 'eta'>, change: string): string =>
  clip(`${opening(agent, vessel)}: ${message.risk}, ETA ${utc(message.eta)}. ${change}`);
