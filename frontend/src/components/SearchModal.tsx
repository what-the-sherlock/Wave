import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Search, Sparkles } from "lucide-react";
import { useSearch } from "../hooks/useSearch";
import { useAskAi } from "../hooks/useAi";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import SearchResultItem from "./SearchResultItem";

const DEBOUNCE_MS = 250;

type Mode = "search" | "ask";

export default function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [mode, setMode] = useState<Mode>("search");
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const navigate = useNavigate();
  const { data: workspaces } = useWorkspaces();
  const lastWorkspaceSlug = useWorkspaceStore((s) => s.lastWorkspaceSlug);
  const workspace = workspaces?.find((w) => w.slug === lastWorkspaceSlug);

  const { data: results, isFetching } = useSearch(workspace?.id, mode === "search" ? debounced : "");
  const ask = useAskAi(workspace?.id);

  useEffect(() => {
    if (!open) {
      setInput("");
      setMode("search");
      ask.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only on open/close, not on every ask identity change
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  if (!open) return null;

  const handleSelect = (channelId: string, seq: number) => {
    if (!workspace) return;
    onClose();
    navigate(`/w/${workspace.slug}/c/${channelId}?seq=${seq}`);
  };

  const askEnabled = Boolean(workspace?.settings.aiEnabled);

  const submitAsk = () => {
    if (!input.trim() || ask.status === "pending" || ask.status === "streaming") return;
    void ask.ask(input.trim());
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-lg p-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-base-300 px-4 py-3">
          {mode === "search" ? (
            <Search className="size-4 text-base-content/40 shrink-0" />
          ) : (
            <Sparkles className="size-4 text-primary shrink-0" />
          )}
          <input
            type="text"
            autoFocus
            placeholder={
              !workspace
                ? "Open a workspace to search"
                : mode === "search"
                  ? `Search in ${workspace.name}…`
                  : `Ask about ${workspace.name}…`
            }
            className="flex-1 bg-transparent outline-none text-sm"
            value={input}
            disabled={!workspace}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "Enter" && mode === "ask") submitAsk();
            }}
          />
          <kbd className="kbd kbd-xs">Esc</kbd>
        </div>

        {askEnabled && (
          <div className="tabs tabs-boxed tabs-xs bg-transparent px-4 pt-2 gap-1 w-fit">
            <button
              type="button"
              className={`tab ${mode === "search" ? "tab-active" : ""}`}
              onClick={() => setMode("search")}
            >
              Search
            </button>
            <button type="button" className={`tab ${mode === "ask" ? "tab-active" : ""}`} onClick={() => setMode("ask")}>
              Ask
            </button>
          </div>
        )}

        <div className="max-h-96 overflow-y-auto">
          {mode === "search" && (
            <>
              {isFetching && <div className="p-4 text-sm text-base-content/50">Searching…</div>}
              {!isFetching && debounced && results?.length === 0 && (
                <div className="p-4 text-sm text-base-content/50">No results for &quot;{debounced}&quot;</div>
              )}
              {!isFetching && results && results.length > 0 && (
                <ul className="menu menu-sm p-2">
                  {results.map((r) => (
                    <SearchResultItem key={r.messageId} result={r} onSelect={() => handleSelect(r.channelId, r.seq)} />
                  ))}
                </ul>
              )}
            </>
          )}

          {mode === "ask" && (
            <div className="p-4 space-y-3">
              {ask.status === "idle" && (
                <p className="text-sm text-base-content/50">
                  Ask a question about this workspace&apos;s history. Press Enter to ask.
                </p>
              )}
              {(ask.status === "pending" || ask.status === "streaming") && ask.text.length === 0 && (
                <div className="flex items-center gap-2 text-sm text-base-content/60">
                  <Loader2 className="size-4 animate-spin" /> Thinking…
                </div>
              )}
              {ask.text.length > 0 && <p className="text-sm whitespace-pre-wrap">{ask.text}</p>}
              {ask.status === "error" && <p className="text-sm text-error">{ask.error}</p>}
              {ask.status === "done" && ask.citations.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {ask.citations.map((c, i) => (
                    <button
                      key={c.messageId}
                      type="button"
                      className="btn btn-xs btn-outline"
                      onClick={() => handleSelect(c.channelId, c.seq)}
                    >
                      Source {i + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
