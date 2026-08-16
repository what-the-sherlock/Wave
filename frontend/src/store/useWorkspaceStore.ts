import { create } from "zustand";

const STORAGE_KEY = "wave-last-workspace-slug";

type WorkspaceState = {
  lastWorkspaceSlug: string | null;
  setLastWorkspaceSlug: (slug: string) => void;
};

/**
 * Remembers only where `/` should redirect to — the `:slug` route param is
 * the actual source of truth for the active workspace
 * (docs/target-architecture.md §8), not this store.
 */
export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  lastWorkspaceSlug: localStorage.getItem(STORAGE_KEY),
  setLastWorkspaceSlug: (slug) => {
    localStorage.setItem(STORAGE_KEY, slug);
    set({ lastWorkspaceSlug: slug });
  },
}));
