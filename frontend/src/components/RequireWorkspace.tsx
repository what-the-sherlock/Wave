import { createContext, useContext, useEffect, type ReactNode } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Loader } from "lucide-react";
import { useWorkspaceBySlug } from "../hooks/useWorkspaces";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import type { Workspace } from "../types/workspace";

const WorkspaceContext = createContext<Workspace | null>(null);

/** Nested pages (members, settings) read the already-resolved workspace
 * here instead of each re-resolving `:slug` themselves. */
export function useWorkspaceContext(): Workspace {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) {
    throw new Error("useWorkspaceContext must be used within <RequireWorkspace>");
  }
  return workspace;
}

/** The workspace equivalent of `RequireAuth`: resolves `:slug` from the URL
 * against the API (which naturally 404s for a slug the caller isn't a
 * member of — no separate permission check needed, docs/security-model.md
 * §4), and remembers it as the redirect target for `/`. */
export function RequireWorkspace({ children }: { children: ReactNode }) {
  const { slug } = useParams<{ slug: string }>();
  const { data: workspace, isLoading, isError } = useWorkspaceBySlug(slug);
  const setLastWorkspaceSlug = useWorkspaceStore((s) => s.setLastWorkspaceSlug);

  useEffect(() => {
    if (workspace) {
      setLastWorkspaceSlug(workspace.slug);
    }
  }, [workspace, setLastWorkspaceSlug]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader className="size-10 animate-spin" />
      </div>
    );
  }

  if (isError || !workspace) {
    return <Navigate to="/" replace />;
  }

  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>;
}
