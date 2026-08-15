import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";
import { queryClient } from "./queryClient";

const baseURL =
  import.meta.env.MODE === "development" ? "http://localhost:5001/api/v1" : "/api/v1";

export const axiosInstance = axios.create({
  baseURL,
  withCredentials: true,
});

type RetriableConfig = InternalAxiosRequestConfig & { _retried?: boolean };
type ApiErrorBody = { code?: string; message?: string };

function isAuthEndpoint(url?: string): boolean {
  if (!url) return false;
  return (
    url.includes("/auth/login") || url.includes("/auth/signup") || url.includes("/auth/refresh")
  );
}

let refreshInFlight: Promise<void> | null = null;

function refreshSession(): Promise<void> {
  refreshInFlight ??= axiosInstance
    .post("/auth/refresh")
    .then(() => undefined)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

/**
 * 401 → refresh → retry once → give up, fixing two things at once:
 *
 *  - D6/the expired-token UX: the original app had no interceptor at all,
 *    so an expired session just showed a broken screen until the user
 *    manually cleared cookies.
 *  - D11: `error.response.data.message` was read directly in every store's
 *    catch block, throwing on any network failure or non-JSON response.
 *
 * On unrecoverable failure this only clears the cached session — it does
 * NOT force-navigate. `RequireAuth`'s declarative `<Navigate>` handles the
 * redirect from the resulting re-render, which is what keeps this from
 * ever becoming a reload loop on the login page itself.
 * docs/target-architecture.md §8, docs/security-model.md §3.
 */
axiosInstance.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiErrorBody>) => {
    const config = error.config as RetriableConfig | undefined;
    const status = error.response?.status;
    const code = error.response?.data?.code;

    if (!config || isAuthEndpoint(config.url)) {
      return Promise.reject(error);
    }

    if (status === 401 && code === "TOKEN_EXPIRED" && !config._retried) {
      config._retried = true;
      try {
        await refreshSession();
        return axiosInstance(config);
      } catch {
        queryClient.setQueryData(["session"], null);
        return Promise.reject(error);
      }
    }

    if (status === 401) {
      queryClient.setQueryData(["session"], null);
    }

    return Promise.reject(error);
  },
);
