import { citations, type BoardMessage } from '../core/board';
import type { Dashboard, Evidence } from '../core/types';

export type Citation = Readonly<{ kind: 'message'; id: string; message: BoardMessage }>
  | Readonly<{ kind: 'evidence'; id: string; evidence: Evidence }>
  | Readonly<{ kind: 'unresolved'; id: string }>;

/** Resolve only records actually present in this snapshot; a citation is not a delivery/read receipt. */
export const resolveBoardCitations = (message: BoardMessage, dashboard: Dashboard): readonly Citation[] => {
  const messages: readonly BoardMessage[] = [
    ...(dashboard.board ?? []),
    ...(dashboard.portStatus ?? []).flatMap(status => status.bulletin ? [status.bulletin] : []),
  ];
  const evidence = dashboard.shipments.flatMap(shipment => shipment.evidence);
  return citations(message).map((id): Citation => {
    const cited = messages.find(candidate => candidate.id === id);
    if (cited) return { kind: 'message', id, message: cited };
    const source = evidence.find(candidate => candidate.id === id);
    return source ? { kind: 'evidence', id, evidence: source } : { kind: 'unresolved', id };
  });
};
