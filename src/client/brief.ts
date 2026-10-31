import type { AssessmentRecord, Shipment } from '../shared';

export const riskLabel = { 'on-track': 'Low risk', watch: 'Moderate risk', delayed: 'High risk' } as const;
export const assessmentFor = (shipment: Shipment): AssessmentRecord | undefined => {
  const records = shipment.assessments ?? [];
  return [...records].reverse().find(record => record.affected) ?? records.at(-1);
};
export const shipmentBrief = (shipment: Shipment): Readonly<{ text: string; source: string }> => {
  // A later unaffected notice must not replace the explanation for retained elevated risk.
  const record = assessmentFor(shipment);
  return {
    text: record?.rationale ?? shipment.change,
    source: record?.method === 'ai-assessed' ? 'AI assessment' : record ? 'Scenario assessment' : 'Shipment status',
  };
};
