import { AlertCircle, FileIcon, Loader2, X } from "lucide-react";

export type PendingUploadState = {
  localId: string;
  name: string;
  status: "uploading" | "error";
};

export default function UploadProgress({
  uploads,
  onRemove,
}: {
  uploads: PendingUploadState[];
  onRemove: (localId: string) => void;
}) {
  if (uploads.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-3 pt-2">
      {uploads.map((u) => (
        <div key={u.localId} className="badge badge-lg gap-1.5 pr-1">
          {u.status === "uploading" ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <AlertCircle className="size-3.5 text-error" />
          )}
          <FileIcon className="size-3.5" />
          <span className="max-w-32 truncate">{u.name}</span>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle"
            onClick={() => onRemove(u.localId)}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}
