import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Hash, Lock, X } from "lucide-react";
import { useCreateChannel } from "../hooks/useChannels";
import type { ChannelType } from "../types/channel";

export default function CreateChannelModal({
  workspaceSlug,
  workspaceId,
  onClose,
}: {
  workspaceSlug: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<Exclude<ChannelType, "DM">>("PUBLIC");
  const createChannel = useCreateChannel(workspaceId);
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const channel = await createChannel.mutateAsync({
        name: name.trim().toLowerCase().replace(/\s+/g, "-"),
        type,
      });
      onClose();
      navigate(`/w/${workspaceSlug}/c/${channel.id}`);
    } catch {
      // useCreateChannel already toasts the error.
    }
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-md">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-lg">Create a channel</h3>
          <button type="button" className="btn btn-sm btn-circle btn-ghost" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="form-control">
            <label className="label">
              <span className="label-text font-medium">Name</span>
            </label>
            <div className="relative">
              <span className="absolute inset-y-0 left-3 flex items-center text-base-content/40">
                #
              </span>
              <input
                type="text"
                className="input input-bordered w-full pl-7"
                placeholder="team-updates"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                autoFocus
              />
            </div>
          </div>

          <div className="form-control gap-2">
            <label className="label cursor-pointer justify-start gap-3">
              <input
                type="radio"
                name="channel-type"
                className="radio radio-sm"
                checked={type === "PUBLIC"}
                onChange={() => setType("PUBLIC")}
              />
              <Hash className="size-4" />
              <span>
                <span className="font-medium">Public</span> — anyone in the workspace can join
              </span>
            </label>
            <label className="label cursor-pointer justify-start gap-3">
              <input
                type="radio"
                name="channel-type"
                className="radio radio-sm"
                checked={type === "PRIVATE"}
                onChange={() => setType("PRIVATE")}
              />
              <Lock className="size-4" />
              <span>
                <span className="font-medium">Private</span> — only invited people can join
              </span>
            </label>
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={createChannel.isPending || !name.trim()}
          >
            Create channel
          </button>
        </form>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
