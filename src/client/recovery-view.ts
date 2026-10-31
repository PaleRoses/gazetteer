import type { BoardMessage } from '../core/board';

export type RecoveryPost = Extract<BoardMessage, { kind: `recovery.${string}` }>;
const isRecovery = (message: BoardMessage): message is RecoveryPost => message.kind.startsWith('recovery.');

export const recoverySteps = [
  { id: 'delay', label: 'Delay detected' },
  { id: 'ask', label: 'Ask for options' },
  { id: 'blocker', label: 'Find the blocker' },
  { id: 'book', label: 'Hold, fit, confirm' },
  { id: 'adapt', label: 'Adapt to a change' },
  { id: 'restart', label: 'Survive a restart' },
] as const;
export type StepId = (typeof recoverySteps)[number]['id'];

export type ThreadPost = Readonly<{ post: RecoveryPost; answers: readonly BoardMessage[] }>;

/** The case's negotiation, oldest first, each post with the posts it answers that the board still holds. */
export const recoveryThread = (board: readonly BoardMessage[], caseId: string | null): readonly ThreadPost[] =>
  board
    .filter(isRecovery)
    .filter(post => caseId === null || post.caseId === caseId)
    .toSorted((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map(post => ({ post, answers: post.answers.flatMap(id => board.filter(message => message.id === id)) }));

/** Which steps the case's own posts have reached. A restart counts only once the cargo agent has posted after it. */
export const litSteps = (thread: readonly ThreadPost[], caseOpen: boolean, restartedAt: string | null): ReadonlySet<StepId> => {
  const posts = thread.map(item => item.post);
  const reached: readonly (readonly [StepId, boolean])[] = [
    ['delay', caseOpen || posts.length > 0],
    ['ask', posts.some(post => post.kind === 'recovery.request')],
    ['blocker', posts.some(post => post.kind === 'recovery.plan' && post.outcome.status === 'blocked')],
    ['book', posts.some(post => post.kind === 'recovery.confirm')],
    ['adapt', posts.some(post => post.kind === 'recovery.withdraw')],
    ['restart', restartedAt !== null && posts.some(post => post.author.role === 'cargo' && Date.parse(post.at) > Date.parse(restartedAt))],
  ];
  return new Set(reached.flatMap(([id, lit]) => lit ? [id] : []));
};

/** The blocking constraint of the latest plan, or null once a plan fits (or before any plan). */
export const currentBlocker = (thread: readonly ThreadPost[]) => {
  const plans = thread.flatMap(item => item.post.kind === 'recovery.plan' ? [item.post] : []);
  const latest = plans[plans.length - 1];
  return latest && latest.outcome.status === 'blocked' ? latest.outcome.blocking : null;
};

/** A hold's time left as m:ss, or null once it has lapsed. */
export const countdown = (expiresAt: string, now: number): string | null => {
  const left = Math.floor((Date.parse(expiresAt) - now) / 1000);
  return left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : null;
};

/** An instant's UTC wall-clock time, 24-hour, as the storyboard reads it. */
export const clock = (at: string): string => new Date(at).toISOString().slice(11, 16);
