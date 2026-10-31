export type View = Readonly<{ kind: 'shipments' | 'routes' | 'news' | 'activity' | 'alerts' }> | Readonly<{ kind: 'route' | 'voyage'; id: string }>;
export function readView(hash: string, workspaceId: string): View {
  try {
    const [kind, workspace, id, extra] = hash.replace(/^#/, '').split('/').map(decodeURIComponent);
    if (workspace !== workspaceId || extra) return { kind: 'shipments' };
    if ((kind === 'routes' || kind === 'news' || kind === 'activity' || kind === 'alerts') && !id) return { kind };
    if ((kind === 'route' || kind === 'voyage') && id) return { kind, id };
  } catch { /* Malformed bookmarks return to the workspace. */ }
  return { kind: 'shipments' };
}
export const viewHash = (view: View, workspaceId: string): string => view.kind === 'shipments' ? '' : `#${view.kind}/${encodeURIComponent(workspaceId)}${'id' in view ? `/${encodeURIComponent(view.id)}` : ''}`;
