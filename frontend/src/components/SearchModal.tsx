import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Search } from "lucide-react";
import { useSearch } from "../hooks/useSearch";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { useWorkspaceStore } from "../store/useWorkspaceStore";
import SearchResultItem from "./SearchResultItem";

const DEBOUNCE_MS = 250;

export default function SearchModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const navigate = useNavigate();
  const { data: workspaces } = useWorkspaces();
  const lastWorkspaceSlug = useWorkspaceStore((s) => s.lastWorkspaceSlug);
  const workspace = workspaces?.find((w) => w.slug === lastWorkspaceSlug);

  useEffect(() => {
    if (!open) setInput("");
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(input), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [input]);

  const { data: results, isFetching } = useSearch(workspace?.id, debounced);

  if (!open) return null;

  const handleSelect = (channelId: string, seq: number) => {
    if (!workspace) return;
    onClose();
    navigate(`/w/${workspace.slug}/c/${channelId}?seq=${seq}`);
  };

  return (
    <div className="modal modal-open">
      <div className="modal-box max-w-lg p-0 overflow-hidden">
        <div className="flex items-center gap-2 border-b border-base-300 px-4 py-3">
          <Search className="size-4 text-base-content/40 shrink-0" />
          <input
            type="text"
            autoFocus
            placeholder={workspace ? `Search in ${workspace.name}…` : "Open a workspace to search"}
            className="flex-1 bg-transparent outline-none text-sm"
            value={input}
            disabled={!workspace}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
            }}
          />
          <kbd className="kbd kbd-xs">Esc</kbd>
        </div>

        <div className="max-h-96 overflow-y-auto">
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
        </div>
      </div>
      <div className="modal-backdrop" onClick={onClose} />
    </div>
  );
}
