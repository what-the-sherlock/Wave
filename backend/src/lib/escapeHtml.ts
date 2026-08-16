/** Shared by every hand-rolled HTML email template (inviteEmail.ts,
 * queue/workers/emailTemplates.ts) — the app sends email via plain
 * template-literal HTML, so escaping user-supplied strings interpolated
 * into it is this module's whole job. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
