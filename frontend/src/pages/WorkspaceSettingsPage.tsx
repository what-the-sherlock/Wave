import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, UserPlus } from "lucide-react";
import { useWorkspaceContext } from "../components/RequireWorkspace";
import { useLeaveWorkspace, useUpdateAiEnabled, useUpdateWorkspace } from "../hooks/useWorkspaces";
import InviteModal from "../components/InviteModal";

const WorkspaceSettingsPage = () => {
  const workspace = useWorkspaceContext();
  const navigate = useNavigate();
  const canManage = workspace.role === "OWNER" || workspace.role === "ADMIN";

  const [name, setName] = useState(workspace.name);
  const updateWorkspace = useUpdateWorkspace();
  const updateAiEnabled = useUpdateAiEnabled();
  const [showInviteModal, setShowInviteModal] = useState(false);
  const leaveWorkspace = useLeaveWorkspace(workspace.id);

  const handleRename = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || name.trim() === workspace.name) return;
    updateWorkspace.mutate({ workspaceId: workspace.id, slug: workspace.slug, patch: { name: name.trim() } });
  };

  const handleLeave = async () => {
    if (!confirm(`Leave ${workspace.name}?`)) return;
    await leaveWorkspace.mutateAsync();
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-screen bg-base-200 pt-20 px-4 pb-12">
      <div className="max-w-2xl mx-auto space-y-6">
        <Link
          to={`/w/${workspace.slug}`}
          className="link link-hover inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" /> Back to {workspace.name}
        </Link>

        <div className="bg-base-100 rounded-lg shadow-cl p-6 space-y-4">
          <h1 className="text-xl font-bold">Workspace settings</h1>
          <form onSubmit={handleRename} className="form-control gap-2">
            <label className="label">
              <span className="label-text font-medium">Name</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                className="input input-bordered flex-1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!canManage}
                maxLength={80}
              />
              {canManage && (
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={updateWorkspace.isPending || !name.trim() || name.trim() === workspace.name}
                >
                  Save
                </button>
              )}
            </div>
          </form>
        </div>

        <div className="bg-base-100 rounded-lg shadow-cl p-6 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold">AI features</h2>
              <p className="text-sm text-base-content/60">
                Semantic search, catch-up summaries, thread summaries, and workspace Q&amp;A.
                Turning this off stops indexing and deletes existing message embeddings.
              </p>
            </div>
            <input
              type="checkbox"
              className="toggle toggle-primary shrink-0"
              checked={workspace.settings.aiEnabled}
              disabled={updateAiEnabled.isPending}
              onChange={(e) =>
                updateAiEnabled.mutate({
                  workspaceId: workspace.id,
                  slug: workspace.slug,
                  aiEnabled: e.target.checked,
                })
              }
            />
          </div>
        </div>

        {canManage && (
          <div className="bg-base-100 rounded-lg shadow-cl p-6 space-y-3">
            <h2 className="text-lg font-bold">Invite people</h2>
            <p className="text-sm text-base-content/60">
              Invite by email or share a link — manage existing invites here too.
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => setShowInviteModal(true)}
            >
              <UserPlus className="size-4" /> Invite people
            </button>
          </div>
        )}

        <div className="bg-base-100 rounded-lg shadow-cl p-6 space-y-2">
          <h2 className="text-lg font-bold">Leave workspace</h2>
          {workspace.role === "OWNER" ? (
            <p className="text-sm text-base-content/60">
              You&apos;re the owner — ownership transfer isn&apos;t supported yet, so you
              can&apos;t leave your own workspace.
            </p>
          ) : (
            <button type="button" className="btn btn-error btn-outline" onClick={handleLeave}>
              Leave {workspace.name}
            </button>
          )}
        </div>
      </div>

      {showInviteModal && (
        <InviteModal workspaceId={workspace.id} onClose={() => setShowInviteModal(false)} />
      )}
    </div>
  );
};

export default WorkspaceSettingsPage;
