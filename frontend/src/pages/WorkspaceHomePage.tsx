import { Navigate } from "react-router-dom";
import { Loader } from "lucide-react";
import { useWorkspaceContext } from "../components/RequireWorkspace";
import { useChannels } from "../hooks/useChannels";

/**
 * `/w/:slug` itself has nothing to render — the chat UI lives at
 * `/w/:slug/c/:channelId` (`ChannelPage`). This redirects to `#general`
 * (every workspace has one, created atomically with the workspace itself —
 * docs/implementation-roadmap.md Phase 2 plan) or, failing that, whichever
 * channel loads first.
 */
const WorkspaceHomePage = () => {
  const workspace = useWorkspaceContext();
  const { data: channels, isLoading } = useChannels(workspace.id);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader className="size-10 animate-spin" />
      </div>
    );
  }

  const target = channels?.find((c) => c.name === "general") ?? channels?.[0];
  if (target) {
    return <Navigate to={`/w/${workspace.slug}/c/${target.id}`} replace />;
  }

  return (
    <div className="flex items-center justify-center h-screen px-4 text-center">
      <p className="text-base-content/60">
        This workspace has no channels yet. Something went wrong during setup.
      </p>
    </div>
  );
};

export default WorkspaceHomePage;
