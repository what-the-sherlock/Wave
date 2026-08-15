export function formatMessageTime(date: string | number | Date): string {
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Fixes D11: the original app read `error.response.data.message` directly
 * in every `catch` block. On a network failure or a non-JSON error
 * response, `error.response` is `undefined`, so that access threw a
 * `TypeError` — replacing a useful message with an unhandled rejection and
 * no toast at all. This never throws, and always returns a string.
 */
export function extractErrorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error && typeof error === "object" && "response" in error) {
    const response = (error as { response?: { data?: { message?: unknown } } }).response;
    const message = response?.data?.message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}
