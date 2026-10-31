import { z } from 'zod';

const maxDelayHours = 24 * 90;
const hours = z.number().min(0).max(maxDelayHours);

export const assessmentSchema = z.object({
  affected: z.boolean(),
  delayHours: z.object({ low: hours, likely: hours, high: hours }),
  risk: z.enum(['on-track', 'watch', 'delayed']),
  rationale: z.string().min(1),
  citedEvidence: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  action: z.string().nullable(),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export type Verdict = Readonly<{ status: 'valid'; assessment: Assessment }> | Readonly<{ status: 'rejected'; reason: string }>;

const reject = (reason: string): Verdict => ({ status: 'rejected', reason });
const citing = z.looseObject({ citedEvidence: z.array(z.string()) });

/** A mind's citations of ids it was never shown are dropped before validation; anything else about the output is left to the validator. */
export const keepShown = (raw: unknown, shown: readonly string[]): unknown => {
  const parsed = citing.safeParse(raw);
  return parsed.success ? { ...parsed.data, citedEvidence: parsed.data.citedEvidence.filter(id => shown.includes(id)) } : raw;
};

/** The model's output is untrusted: it must parse, be ordered, and cite only evidence it was given. */
export function validateAssessment(raw: unknown, allowedEvidence: readonly string[]): Verdict {
  const parsed = assessmentSchema.safeParse(raw);
  if (!parsed.success) return reject(`schema: ${parsed.error.issues[0]?.path.join('.') || 'root'}: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
  const { delayHours, citedEvidence, affected } = parsed.data;
  const invented = citedEvidence.filter(id => !allowedEvidence.includes(id));
  if (invented.length) return reject(`cited evidence not in the input: ${invented.join(', ')}`);
  if (!(delayHours.low <= delayHours.likely && delayHours.likely <= delayHours.high)) return reject('delay range is not ordered low <= likely <= high');
  if (affected && !citedEvidence.length) return reject('an affecting assessment must cite evidence');
  if (!affected && delayHours.high !== 0) return reject('an unaffected assessment must carry no delay');
  return { status: 'valid', assessment: parsed.data };
}
