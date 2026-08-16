import { X } from "lucide-react";
import AiSummaryView from "./AiSummaryView";
import type { useCatchupSummary } from "../hooks/useAi";

export default function CatchupModal({
  summary,
  onClose,
}: {
  summary: ReturnType<typeof useCatchupSummary>;
  onClose: () => void;
}) {
  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-md">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-semibold">Catch me up</h3>
          <button type="button" className="btn btn-xs btn-ghost btn-circle" onClick={onClose}>
            <X className="size-4" />
          </button>
        </div>
        <AiSummaryView status={summary.status} summary={summary.summary} error={summary.error} />
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
