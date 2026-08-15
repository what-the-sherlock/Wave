import { useEffect } from "react";
import "./index.css";
import { Routes, Route } from "react-router-dom";
import { Toaster } from "react-hot-toast";

import Navbar from "./components/Navbar";
import HomePage from "./pages/HomePage";
import SignUpPage from "./pages/SignUpPage";
import SettingsPage from "./pages/SettingsPage";
import ProfilePage from "./pages/ProfilePage";
import LoginPage from "./pages/LoginPage";
import { RequireAuth } from "./components/RequireAuth";
import { RequireGuest } from "./components/RequireGuest";

import { useAuthStore } from "./store/useAuthStore";
import { useThemeStore } from "./store/useThemeStore";
import { useSession } from "./hooks/useSession";

function App() {
  const { theme } = useThemeStore();
  const { data: session } = useSession();
  const { connectSocket, disconnectSocket } = useAuthStore();

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

  return (
    <div data-theme={theme}>
      <Navbar />

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
      </Routes>

      <Toaster />
    </div>
  );
}

export default App;
