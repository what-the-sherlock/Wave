import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Loader } from "lucide-react";
import { useSession } from "../hooks/useSession";

/** Replaces the inline `authUser ? <Page/> : <Navigate to="/login"/>`
 * ternaries scattered through the router — the pattern stops scaling once
 * there are more than a handful of routes (docs/target-architecture.md §6). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: session, isLoading } = useSession();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader className="size-10 animate-spin" />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}
