import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { EMOJI_CATEGORIES } from "../constants/emoji";

/**
 * The full emoji set — `MessageItem.tsx`'s hover toolbar still shows the
 * fast-path `QUICK_REACTIONS` strip above this; this is what makes every
 * other emoji reachable instead of the six quick ones being the only
 * reactions anyone could ever apply.
 */
export default function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return EMOJI_CATEGORIES;
    return EMOJI_CATEGORIES.map((category) => ({
      ...category,
      emoji: category.emoji.filter(
        (e) => e.name.includes(q) || e.keywords.some((k) => k.includes(q)),
      ),
    })).filter((category) => category.emoji.length > 0);
  }, [query]);

  return (
    <div className="w-72 bg-base-100 border border-base-300 rounded-lg shadow-lg flex flex-col">
      <div className="p-2 border-b border-base-300 relative">
        <Search className="size-3.5 absolute left-4 top-1/2 -translate-y-1/2 text-base-content/40" />
        <input
          type="text"
          className="input input-sm input-bordered w-full pl-8"
          placeholder="Search emoji..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
      </div>
      <div className="max-h-64 overflow-y-auto p-2 space-y-2">
        {filtered.length === 0 && (
          <p className="text-xs text-base-content/50 text-center py-4">No emoji found</p>
        )}
        {filtered.map((category) => (
          <div key={category.label}>
            <p className="text-[10px] font-semibold uppercase text-base-content/40 px-1 mb-1">
              {category.label}
            </p>
            <div className="grid grid-cols-8 gap-0.5">
              {category.emoji.map((e) => (
                <button
                  key={e.char}
                  type="button"
                  className="btn btn-ghost btn-xs text-lg p-0 h-8 w-8"
                  title={e.name}
                  onClick={() => onPick(e.char)}
                >
                  {e.char}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
