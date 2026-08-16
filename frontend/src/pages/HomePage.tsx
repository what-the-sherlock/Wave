import { useEffect } from "react";
import { Link, Navigate } from "react-router-dom";
import { Loader } from "lucide-react";
import { WaveMark } from "../components/WaveLogo";
import { useProfile } from "../hooks/useProfile";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { useWorkspaceStore } from "../store/useWorkspaceStore";

/**
 * Redirects into a workspace once one exists — the workspace-scoped chat UI
 * lives at `/w/:slug` (`WorkspaceHomePage`, and channels once Phase 3
 * lands). With zero workspaces, this stays the account-setup landing page.
 */
const HomePage = () => {
  const { data: profile } = useProfile();
  const { data: workspaces, isLoading } = useWorkspaces();
  const { lastWorkspaceSlug, setLastWorkspaceSlug } = useWorkspaceStore();

  const target =
    workspaces?.find((w) => w.slug === lastWorkspaceSlug)?.slug ?? workspaces?.[0]?.slug;

  useEffect(() => {
    if (target) {
      setLastWorkspaceSlug(target);
    }
  }, [target, setLastWorkspaceSlug]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader className="size-10 animate-spin" />
      </div>
    );
  }

  if (target) {
    return <Navigate to={`/w/${target}`} replace />;
  }

  return (
    <div className="h-screen bg-base-200">
      <div className="flex items-center justify-center pt-20 px-4">
        <div className="bg-base-100 rounded-lg shadow-cl w-full max-w-2xl p-10 text-center space-y-6">
          <div className="flex justify-center">
            <WaveMark className="h-16 w-auto text-primary" />
          </div>

          <div>
            <h1 className="text-2xl font-bold">
              Welcome{profile?.fullName ? `, ${profile.fullName}` : ""}!
            </h1>
            <p className="text-base-content/60 mt-2">
              You&apos;re signed in. Create a workspace to get started, or wait for a teammate to
              invite you to theirs.
            </p>
          </div>

          <Link to="/w/new" className="btn btn-primary">
            Create a workspace
          </Link>

          <div className="text-sm text-base-content/50 border-t border-base-300 pt-4">
            In the meantime, check out{" "}
            <Link to="/settings" className="link link-primary">
              Settings
            </Link>{" "}
            to pick a theme, or{" "}
            <Link to="/profile" className="link link-primary">
              Profile
            </Link>{" "}
            to update your name.
          </div>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
