import { useQuery } from "@tanstack/react-query";
import { axiosInstance } from "../lib/axios";

export type SearchResult = {
  messageId: string;
  channelId: string;
  seq: number;
  createdAt: string;
  snippet: string;
  rank: number;
};

export function useSearch(workspaceId: string | undefined, query: string) {
  const trimmed = query.trim();
  return useQuery({
    queryKey: ["search", workspaceId, trimmed],
    queryFn: async () => {
      const res = await axiosInstance.get<{ results: SearchResult[] }>(
        `/workspaces/${workspaceId}/search`,
        { params: { q: trimmed } },
      );
      return res.data.results;
    },
    enabled: Boolean(workspaceId) && trimmed.length > 0,
    staleTime: 5_000,
  });
}
