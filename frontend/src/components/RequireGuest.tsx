import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { Loader } from "lucide-react";
import { useSession } from "../hooks/useSession";

/** The inverse of `RequireAuth` — for /login and /signup, which should
 * bounce an already-authenticated visitor back to the app. */
export function RequireGuest({ children }: { children: ReactNode }) {
  const { data: session, isLoading } = useSession();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader className="size-10 animate-spin" />
      </div>
    );
  }

  if (session) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
