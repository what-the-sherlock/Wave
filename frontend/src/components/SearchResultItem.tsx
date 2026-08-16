import { formatMessageTime } from "../lib/utils";
import type { SearchResult } from "../hooks/useSearch";

export default function SearchResultItem({
  result,
  onSelect,
}: {
  result: SearchResult;
  onSelect: () => void;
}) {
  return (
    <li>
      <button type="button" onClick={onSelect} className="flex flex-col items-start gap-0.5 py-2">
        {/* ts_headline wraps only the matched terms in <b> — Postgres-
            generated markup around escaped user text, not raw HTML from the
            message body (docs/database-design.md §10). */}
        <span
          className="text-sm [&_b]:font-semibold [&_b]:text-primary"
          dangerouslySetInnerHTML={{ __html: result.snippet }}
        />
        <span className="text-xs text-base-content/40">{formatMessageTime(result.createdAt)}</span>
      </button>
    </li>
  );
}
