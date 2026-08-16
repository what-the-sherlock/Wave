import type { ReactNode } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { Loader } from "lucide-react";
import { useSession } from "../hooks/useSession";

/**
 * The inverse of `RequireAuth` — for /login and /signup, which should
 * bounce an already-authenticated visitor onward. Honors `?next=`
 * (falling back to `/`) so a not-yet-registered invitee who followed
 * `/invite/:token`'s login/signup links lands back on the invite instead of
 * losing it — this is the actual redirect decision point, since `login()`/
 * `signup()` in `useAuthStore` swallow their own errors and never reject, so
 * "did it work" is observed by this component re-rendering once the session
 * query resolves, not by awaiting the action.
 */
export function RequireGuest({ children }: { children: ReactNode }) {
  const { data: session, isLoading } = useSession();
  const [searchParams] = useSearchParams();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <Loader className="size-10 animate-spin" />
      </div>
    );
  }

  if (session) {
    const next = searchParams.get("next");
    return <Navigate to={next && next.startsWith("/") ? next : "/"} replace />;
  }

  return <>{children}</>;
}
