import { Link, useParams } from "react-router-dom";
import { ChevronDown, Plus } from "lucide-react";
import { useWorkspaces } from "../hooks/useWorkspaces";
import { useSession } from "../hooks/useSession";

/** Dropdown of the caller's workspaces, highlighting the one whose slug
 * matches the current route (if any). Renders nothing for a signed-out
 * visitor or someone with zero workspaces yet — there's nothing to switch
 * between. */
export default function WorkspaceSwitcher() {
  const { data: session } = useSession();
  const { data: workspaces } = useWorkspaces();
  const { slug: activeSlug } = useParams<{ slug: string }>();

  if (!session || !workspaces || workspaces.length === 0) {
    return null;
  }

  const active = workspaces.find((w) => w.slug === activeSlug);

  return (
    <div className="dropdown">
      <button type="button" tabIndex={0} className="btn btn-sm btn-ghost gap-1">
        <span className="max-w-[10rem] truncate">{active?.name ?? "Workspaces"}</span>
        <ChevronDown className="size-4" />
      </button>
      <ul
        tabIndex={0}
        className="dropdown-content menu bg-base-100 rounded-box z-10 w-56 p-2 shadow-lg border border-base-300"
      >
        {workspaces.map((w) => (
          <li key={w.id}>
            <Link to={`/w/${w.slug}`} className={w.slug === activeSlug ? "active" : ""}>
              {w.name}
            </Link>
          </li>
        ))}
        <li>
          <Link to="/w/new" className="text-primary">
            <Plus className="size-4" /> New workspace
          </Link>
        </li>
      </ul>
    </div>
  );
}
