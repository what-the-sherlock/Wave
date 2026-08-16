import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { WaveMark } from "../components/WaveLogo";
import { useSession } from "../hooks/useSession";
import { useAcceptInvite, useInvitePreview } from "../hooks/useWorkspaces";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import { axiosInstance } from "../lib/axios";

/**
 * Deliberately not wrapped in `<RequireAuth>` — an invite link is the one
 * place an unauthenticated visitor needs to land productively, so the page
 * itself branches on session state rather than bouncing to /login first and
 * losing the token.
 */
const InvitePage = () => {
  const { token } = useParams<{ token: string }>();
  const { data: session, isLoading: sessionLoading } = useSession();
  const { data: preview, isLoading: previewLoading, isError } = useInvitePreview(token);
  const acceptInvite = useAcceptInvite();
  const setLastWorkspaceSlug = useWorkspaceStore((s) => s.setLastWorkspaceSlug);
  const navigate = useNavigate();
  const [accepting, setAccepting] = useState(false);

  const nextParam = `?next=${encodeURIComponent(`/invite/${token}`)}`;

  const handleAccept = async () => {
    if (!token) return;
    setAccepting(true);
    try {
      const result = await acceptInvite.mutateAsync(token);
      const wsRes = await axiosInstance.get(`/workspaces/${result.workspaceId}`);
      setLastWorkspaceSlug(wsRes.data.slug);
      navigate(`/w/${wsRes.data.slug}`, { replace: true });
    } catch {
      setAccepting(false);
    }
  };

  return (
    <div className="h-screen flex items-center justify-center px-4 bg-base-200">
      <div className="bg-base-100 rounded-lg shadow-cl w-full max-w-md p-10 text-center space-y-6">
        <div className="flex justify-center">
          <WaveMark className="h-16 w-auto text-primary" />
        </div>

        {sessionLoading ? (
          <Loader2 className="size-8 animate-spin mx-auto" />
        ) : !session ? (
          <>
            <h1 className="text-xl font-bold">You&apos;ve been invited to a workspace on wave</h1>
            <p className="text-base-content/60">Log in or create an account to view and accept.</p>
            <div className="flex gap-2 justify-center">
              <Link to={`/login${nextParam}`} className="btn btn-primary">
                Log in
              </Link>
              <Link to={`/signup${nextParam}`} className="btn btn-outline">
                Sign up
              </Link>
            </div>
          </>
        ) : previewLoading ? (
          <Loader2 className="size-8 animate-spin mx-auto" />
        ) : isError || !preview?.isValid ? (
          <>
            <h1 className="text-xl font-bold">This invite isn&apos;t valid</h1>
            <p className="text-base-content/60">
              It may have expired, been revoked, or already been used up.
            </p>
            <Link to="/" className="link link-primary">
              Go home
            </Link>
          </>
        ) : (
          <>
            <h1 className="text-xl font-bold">Join {preview.workspaceName}</h1>
            <p className="text-base-content/60">
              {preview.inviterName} invited you to join this workspace.
            </p>
            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={handleAccept}
              disabled={accepting}
            >
              {accepting ? <Loader2 className="size-5 animate-spin" /> : `Accept invite`}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

export default InvitePage;
