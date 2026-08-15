import { useQuery } from "@tanstack/react-query";
import type { AxiosError } from "axios";
import { axiosInstance } from "../lib/axios";

export type SessionUser = {
  id: string;
  email: string;
};

async function fetchSession(): Promise<SessionUser | null> {
  try {
    const res = await axiosInstance.get<SessionUser>("/auth/check");
    return res.data;
  } catch (error) {
    if ((error as AxiosError).response?.status === 401) {
      return null;
    }
    throw error;
  }
}

/**
 * The one query wired through TanStack Query in Phase 1 — proving the
 * pattern before Phase 3 moves message history onto `useInfiniteQuery`
 * (docs/target-architecture.md §6, §8). `null` means "checked, not logged
 * in"; `undefined` (via `isLoading`) means "still checking".
 */
export function useSession() {
  return useQuery({
    queryKey: ["session"],
    queryFn: fetchSession,
    staleTime: 60_000,
  });
}
