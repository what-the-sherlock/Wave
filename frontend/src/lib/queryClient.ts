import { QueryClient } from "@tanstack/react-query";

/**
 * A single shared instance — imported by both the React tree (via
 * QueryClientProvider) and the axios interceptor, which needs to be able
 * to invalidate the session query when a request comes back unauthorized
 * without importing any React code itself.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});
