import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { WaveMark } from "../components/WaveLogo";
import { useCreateWorkspace } from "../hooks/useWorkspaces";

const CreateWorkspacePage = () => {
  const [name, setName] = useState("");
  const { mutateAsync, isPending } = useCreateWorkspace();
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const workspace = await mutateAsync(name.trim());
      navigate(`/w/${workspace.slug}`, { replace: true });
    } catch {
      // useCreateWorkspace already toasts the error.
    }
  };

  return (
    <div className="h-screen flex items-center justify-center px-4 bg-base-200">
      <div className="w-full max-w-md space-y-8">
        <div className="text-center space-y-2">
          <div className="flex justify-center">
            <WaveMark className="h-14 w-auto text-primary" />
          </div>
          <h1 className="text-2xl font-bold">Create a workspace</h1>
          <p className="text-base-content/60">
            A workspace is where your team&apos;s channels and conversations live.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="form-control">
            <label className="label">
              <span className="label-text font-medium">Workspace name</span>
            </label>
            <input
              type="text"
              className="input input-bordered w-full"
              placeholder="Acme Inc."
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
            />
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={isPending || !name.trim()}
          >
            {isPending ? (
              <>
                <Loader2 className="h-5 w-5 animate-spin" />
                Creating...
              </>
            ) : (
              "Create workspace"
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

export default CreateWorkspacePage;
