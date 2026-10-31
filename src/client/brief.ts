import type { Shipment } from '../shared';

export const riskLabel = { 'on-track': 'Low risk', watch: 'Moderate risk', delayed: 'High risk' } as const;
export const shipmentBrief = (shipment: Shipment): Readonly<{ text: string; source: string }> => {
  // A later unaffected notice must not replace the explanation for retained elevated risk.
  const records = shipment.assessments ?? [];
  const record = [...records].reverse().find(record => record.affected) ?? records.at(-1);
  return {
    text: record?.rationale ?? shipment.change,
    source: record?.method === 'ai-assessed' ? 'AI assessment' : record ? 'Scenario assessment' : 'Shipment status',
  };
};
