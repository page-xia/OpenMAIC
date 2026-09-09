import { WorkspaceShell } from '@/components/workbench/workspace/WorkspaceShell';

/** Integration seam for the independently landed workspace-shell slice. */
export function WorkspaceEntry({ exitHref }: { readonly exitHref: string }) {
  return <WorkspaceShell exitHref={exitHref} />;
}
