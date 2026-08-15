import { Link } from "react-router-dom";
import { MessageSquare } from "lucide-react";
import { useProfile } from "../hooks/useProfile";

/**
 * Phase 1 has no workspaces, channels, or messages yet — those arrive in
 * Phases 2–3. Wiring this page back up to the old Sidebar/ChatContainer
 * would mean rendering a UI that immediately 404s against endpoints that
 * no longer exist, which is worse than an honest placeholder. Those
 * components (docs/target-architecture.md §11) are kept in the repo,
 * untouched and dormant, and get reconnected here once channels exist.
 */
const HomePage = () => {
  const { data: profile } = useProfile();

  return (
    <div className="h-screen bg-base-200">
      <div className="flex items-center justify-center pt-20 px-4">
        <div className="bg-base-100 rounded-lg shadow-cl w-full max-w-2xl p-10 text-center space-y-6">
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
              <MessageSquare className="w-8 h-8 text-primary" />
            </div>
          </div>

          <div>
            <h1 className="text-2xl font-bold">
              Welcome{profile?.fullName ? `, ${profile.fullName}` : ""}!
            </h1>
            <p className="text-base-content/60 mt-2">
              You&apos;re signed in and your account is set up. Workspaces, channels, and
              messaging are on the way in the next phases of the rebuild.
            </p>
          </div>

          <div className="text-sm text-base-content/50 border-t border-base-300 pt-4">
            In the meantime, check out{" "}
            <Link to="/settings" className="link link-primary">
              Settings
            </Link>{" "}
            to pick a theme, or{" "}
            <Link to="/profile" className="link link-primary">
              Profile
            </Link>{" "}
            to update your name.
          </div>
        </div>
      </div>
    </div>
  );
};

export default HomePage;
