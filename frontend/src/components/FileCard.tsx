import { Download, FileText, Loader2 } from "lucide-react";
import { useDownloadUrl } from "../hooks/useUploads";
import { formatBytes } from "../lib/utils";
import type { Attachment } from "../types/channel";

export default function FileCard({ attachment }: { attachment: Attachment }) {
  const { data: url, isFetching, refetch } = useDownloadUrl(attachment.id, false);

  const handleClick = async () => {
    const result = url ? { data: url } : await refetch();
    if (result.data) {
      window.open(result.data, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className="flex items-center gap-2.5 mt-1.5 p-2 pr-3 rounded-lg border border-base-300 bg-base-200/50 hover:bg-base-200 max-w-xs text-left"
    >
      <FileText className="size-8 text-base-content/40 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{attachment.name}</p>
        <p className="text-xs text-base-content/50">{formatBytes(attachment.sizeBytes)}</p>
      </div>
      {isFetching ? (
        <Loader2 className="size-4 animate-spin shrink-0" />
      ) : (
        <Download className="size-4 shrink-0 text-base-content/50" />
      )}
    </button>
  );
}
