export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

export function formatMessageTime(date: string | number | Date): string {
  return new Date(date).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** A full date + time for the `title` attribute on a message timestamp —
 * `formatMessageTime` alone is bare HH:MM regardless of age, so a
 * three-week-old message otherwise reads as if it were sent minutes ago. */
export function formatFullTimestamp(date: string | number | Date): string {
  return new Date(date).toLocaleString("en-US", {
    dateStyle: "long",
    timeStyle: "short",
  });
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** "Today" / "Yesterday" / a full date, for the scrollback's date
 * separators. */
export function formatDateSeparator(date: string | number | Date): string {
  const d = new Date(date);
  const now = new Date();
  if (isSameDay(d, now)) return "Today";

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (isSameDay(d, yesterday)) return "Yesterday";

  return d.toLocaleDateString("en-US", {
    day: "numeric",
    month: "long",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
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
