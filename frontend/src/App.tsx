import { useEffect, useState } from "react";
import "./index.css";
import { Routes, Route } from "react-router-dom";
import { Toaster } from "react-hot-toast";

import Navbar from "./components/Navbar";
import SearchModal from "./components/SearchModal";
import HomePage from "./pages/HomePage";
import SignUpPage from "./pages/SignUpPage";
import SettingsPage from "./pages/SettingsPage";
import ProfilePage from "./pages/ProfilePage";
import LoginPage from "./pages/LoginPage";
import CreateWorkspacePage from "./pages/CreateWorkspacePage";
import WorkspaceHomePage from "./pages/WorkspaceHomePage";
import ChannelPage from "./pages/ChannelPage";
import WorkspaceMembersPage from "./pages/WorkspaceMembersPage";
import WorkspaceSettingsPage from "./pages/WorkspaceSettingsPage";
import InvitePage from "./pages/InvitePage";
import { RequireAuth } from "./components/RequireAuth";
import { RequireGuest } from "./components/RequireGuest";
import { RequireWorkspace } from "./components/RequireWorkspace";

import { useAuthStore } from "./store/useAuthStore";
import { useThemeStore } from "./store/useThemeStore";
import { useSession } from "./hooks/useSession";
import { useOutboxFlush } from "./hooks/useOutboxFlush";
import { useNotificationSocketEvents } from "./hooks/useNotificationSocketEvents";
import { useAttachmentReadySocketSync } from "./hooks/useMessages";

function App() {
  const { theme } = useThemeStore();
  const { data: session } = useSession();
  const { connectSocket, disconnectSocket } = useAuthStore();
  const [searchOpen, setSearchOpen] = useState(false);

  // Cmd/Ctrl+K opens search from anywhere — mirrors the roadmap's "search
  // modal (Cmd/Ctrl+K)" requirement (docs/implementation-roadmap.md Phase 6).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Socket lifecycle tracks session identity reactively — connects once a
  // session resolves (fresh login, signup, or an already-valid cookie on
  // load) and disconnects on logout, rather than each auth action having
  // to remember to call connectSocket() itself.
  useEffect(() => {
    if (session?.id) {
      connectSocket();
    } else {
      disconnectSocket();
    }
  }, [session?.id, connectSocket, disconnectSocket]);

  // Global, not per-channel — a message can be queued while its channel
  // isn't open, and must still flush on reconnect.
  useOutboxFlush();

  // Global, not per-channel — a notification can arrive for a workspace
  // whose page isn't open (docs/implementation-roadmap.md Phase 5).
  useNotificationSocketEvents();

  // Global — the uploader may have navigated away from the channel by the
  // time the thumbnail finishes processing.
  useAttachmentReadySocketSync();

  // Ask once per session, only once a user is actually signed in, and only
  // if the browser hasn't already been asked (asking again after "denied"
  // just reopens a dead-end prompt on most browsers).
  useEffect(() => {
    if (
      session?.id &&
      typeof Notification !== "undefined" &&
      Notification.permission === "default"
    ) {
      void Notification.requestPermission();
    }
  }, [session?.id]);

  return (
    <div data-theme={theme}>
      <Navbar onOpenSearch={() => setSearchOpen(true)} />

      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <HomePage />
            </RequireAuth>
          }
        />
        <Route
          path="/signup"
          element={
            <RequireGuest>
              <SignUpPage />
            </RequireGuest>
          }
        />
        <Route
          path="/login"
          element={
            <RequireGuest>
              <LoginPage />
            </RequireGuest>
          }
        />
        <Route path="/settings" element={<SettingsPage />} />
        <Route
          path="/profile"
          element={
            <RequireAuth>
              <ProfilePage />
            </RequireAuth>
          }
        />

        <Route
          path="/w/new"
          element={
            <RequireAuth>
              <CreateWorkspacePage />
            </RequireAuth>
          }
        />
        <Route
          path="/w/:slug"
          element={
            <RequireAuth>
              <RequireWorkspace>
                <WorkspaceHomePage />
              </RequireWorkspace>
            </RequireAuth>
          }
        />
        <Route
          path="/w/:slug/c/:channelId"
          element={
            <RequireAuth>
              <RequireWorkspace>
                <ChannelPage />
              </RequireWorkspace>
            </RequireAuth>
          }
        />
        <Route
          path="/w/:slug/members"
          element={
            <RequireAuth>
              <RequireWorkspace>
                <WorkspaceMembersPage />
              </RequireWorkspace>
            </RequireAuth>
          }
        />
        <Route
          path="/w/:slug/settings"
          element={
            <RequireAuth>
              <RequireWorkspace>
                <WorkspaceSettingsPage />
              </RequireWorkspace>
            </RequireAuth>
          }
        />
        {/* Not wrapped in RequireAuth — InvitePage branches on session
            state itself so an unauthenticated visitor keeps the token in
            the URL instead of being bounced to /login before it can be
            read (docs/implementation-roadmap.md Phase 2 frontend plan). */}
        <Route path="/invite/:token" element={<InvitePage />} />
      </Routes>

      <SearchModal open={searchOpen} onClose={() => setSearchOpen(false)} />
      <Toaster />
    </div>
  );
}

export default App;
