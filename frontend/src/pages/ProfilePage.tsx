import { useEffect, useState } from "react";
import { Mail, User } from "lucide-react";
import { useSession } from "../hooks/useSession";
import { useProfile, useUpdateProfile } from "../hooks/useProfile";

/**
 * Avatar upload is deliberately not here yet — there is no upload
 * mechanism until Supabase Storage lands in Phase 6, and accepting an
 * arbitrary client-supplied URL as "your avatar" with nothing backing it
 * would be a half-built feature rather than a real one
 * (docs/database-design.md, profile.schemas.ts). Name and timezone editing
 * are real, working endpoints, so they're wired up here now.
 */
const ProfilePage = () => {
  const { data: session } = useSession();
  const { data: profile, isLoading } = useProfile();
  const updateProfile = useUpdateProfile();

  const [fullName, setFullName] = useState("");
  const [timezone, setTimezone] = useState("");

  useEffect(() => {
    if (profile) {
      setFullName(profile.fullName);
      setTimezone(profile.timezone);
    }
  }, [profile]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const patch: { fullName?: string; timezone?: string } = {};
    if (profile && fullName.trim() && fullName !== profile.fullName) {
      patch.fullName = fullName.trim();
    }
    if (profile && timezone.trim() && timezone !== profile.timezone) {
      patch.timezone = timezone.trim();
    }
    if (Object.keys(patch).length === 0) return;
    updateProfile.mutate(patch);
  };

  const initial = profile?.fullName?.charAt(0).toUpperCase() ?? "?";

  return (
    <div className="h-screen pt-20">
      <div className="max-w-2xl mx-auto p-4 py-8">
        <div className="bg-base-300 rounded-xl p-6 space-y-8">
          <div className="text-center">
            <h1 className="text-2xl font-semibold">Profile</h1>
            <p className="mt-2">Your profile information</p>
          </div>

          <div className="flex flex-col items-center gap-4">
            <div className="size-32 rounded-full border-4 bg-primary/10 flex items-center justify-center text-4xl font-semibold text-primary">
              {initial}
            </div>
            <p className="text-sm text-zinc-400">Avatar uploads are coming in a later phase</p>
          </div>

          {isLoading ? (
            <p className="text-center text-sm text-zinc-400">Loading...</p>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-6">
              <div className="space-y-1.5">
                <label className="text-sm text-zinc-400 flex items-center gap-2" htmlFor="fullName">
                  <User className="w-4 h-4" />
                  Full Name
                </label>
                <input
                  id="fullName"
                  type="text"
                  className="input input-bordered w-full"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  maxLength={80}
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-sm text-zinc-400 flex items-center gap-2" htmlFor="timezone">
                  Timezone
                </label>
                <input
                  id="timezone"
                  type="text"
                  className="input input-bordered w-full"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  placeholder="e.g. America/New_York"
                  maxLength={64}
                />
              </div>

              <div className="space-y-1.5">
                <div className="text-sm text-zinc-400 flex items-center gap-2">
                  <Mail className="w-4 h-4" />
                  Email Address
                </div>
                <p className="px-4 py-2.5 bg-base-200 rounded-lg border">{session?.email}</p>
              </div>

              <button
                type="submit"
                className="btn btn-primary w-full"
                disabled={updateProfile.isPending}
              >
                {updateProfile.isPending ? "Saving..." : "Save changes"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
};

export default ProfilePage;
