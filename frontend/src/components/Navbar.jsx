import { Link } from "react-router-dom";
import { useAuthStore } from "../store/useAuthStore";
import { useSession } from "../hooks/useSession";
import { LogOut, Search, Settings, User } from "lucide-react";
import WorkspaceSwitcher from "./WorkspaceSwitcher";
import NotificationBell from "./NotificationBell";
import { WaveMark, WaveWordmark } from "./WaveLogo";

const Navbar = ({ onOpenSearch }) => {
  const { logout } = useAuthStore();
  const { data: session } = useSession();

  return (
    <header
      className="bg-base-100 border-b border-base-300 fixed w-full top-0 z-40 
    backdrop-blur-lg bg-base-100/80"
    >
      <div className="container mx-auto px-4 h-16">
        <div className="flex items-center justify-between h-full">
          <div className="flex items-center gap-8">
            <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-all">
              <WaveMark className="h-7 w-auto text-primary" />
              <h1>
                <WaveWordmark className="text-2xl" />
              </h1>
            </Link>
            <WorkspaceSwitcher />
          </div>

          <div className="flex items-center gap-2">
            {session && (
              <button
                type="button"
                className="btn btn-sm btn-ghost btn-circle"
                onClick={onOpenSearch}
                title="Search (⌘K)"
              >
                <Search className="size-5" />
              </button>
            )}
            {session && <NotificationBell />}
            <Link
              to={"/settings"}
              className={`
              btn btn-sm gap-2 transition-colors
              
              `}
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">Settings</span>
            </Link>

            {session && (
              <>
                <Link to={"/profile"} className={`btn btn-sm gap-2`}>
                  <User className="size-5" />
                  <span className="hidden sm:inline">Profile</span>
                </Link>

                <button className="flex gap-2 items-center" onClick={logout}>
                  <LogOut className="size-5" />
                  <span className="hidden sm:inline">Logout</span>
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
export default Navbar;
