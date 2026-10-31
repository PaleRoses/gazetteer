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
export const observationSummary = (vessel: string, titles: readonly string[], measured: NonNullable<ShipObservation['measured']>, nearPort: PortId | null): string =>
  clip(`${vessel}: ${titles.join('; ')}${nearPort ? ` near ${portName(nearPort)}` : ''}. ${Object.entries(readings).flatMap(([key, label]) => {
    const value = measured[key];
    return typeof value === 'number' ? [`${value} ${label}`] : [];
  }).join(', ')}.`.replace(/ \.$/, '.'));

export const ruleAssessmentSummary = (vessel: string, message: Pick<ShipAssessment, 'risk' | 'eta' | 'delayHours' | 'basis'>, reasons: readonly string[]): string =>
  clip(`${vessel}, by rule: ${message.risk}. ${reasons.join('; ')}.${message.basis ? ` ${message.basis.anchored} anchored at ${portName(message.basis.portId)}, ${message.delayHours?.likely ?? 0} h likely queue delay.` : ''} ETA ${utc(message.eta)}.`);

export const etaSummary = (vessel: string, portId: PortId, eta: string, previousEta: string): string =>
  clip(`${vessel} expects ${portName(portId)} at ${utc(eta)}${eta === previousEta ? '' : `, from ${utc(previousEta)}`}.`);
