import { Loader2, Sparkles } from "lucide-react";
import type { AiSummaryPayload } from "../types/ai";
import type { SummaryStatus } from "../hooks/useAi";

export default function AiSummaryView({
  status,
  summary,
  error,
}: {
  status: SummaryStatus;
  summary: AiSummaryPayload | null;
  error: string | null;
}) {
  if (status === "idle") return null;

  if (status === "pending") {
    return (
      <div className="flex items-center gap-2 text-sm text-base-content/60 p-3">
        <Loader2 className="size-4 animate-spin" /> Summarizing…
      </div>
    );
  }

  if (status === "error") {
    return <div className="text-sm text-error p-3">{error ?? "Could not generate a summary."}</div>;
  }

  if (!summary) return null;

  return (
    <div className="space-y-3 p-3 bg-base-200 rounded-lg text-sm">
      <div className="flex items-center gap-1.5 font-semibold text-primary">
        <Sparkles className="size-4" /> AI summary
      </div>

      {summary.bullets.length > 0 && (
        <ul className="list-disc list-inside space-y-1">
          {summary.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}

      {summary.decisions.length > 0 && (
        <div>
          <div className="font-medium text-base-content/70">Decisions</div>
          <ul className="list-disc list-inside space-y-1">
            {summary.decisions.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.needsYourInput.length > 0 && (
        <div>
          <div className="font-medium text-warning">Needs your input</div>
          <ul className="list-disc list-inside space-y-1">
            {summary.needsYourInput.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {summary.truncated && (
        <div className="text-xs text-base-content/50">
          Only the most recent messages were summarized — there was more to cover.
        </div>
      )}
    </div>
  );
}
