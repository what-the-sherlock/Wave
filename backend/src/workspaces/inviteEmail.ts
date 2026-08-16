import { config } from "../config/env.js";
import { logger } from "../logging/logger.js";
import { escapeHtml } from "../lib/escapeHtml.js";

/**
 * Best-effort, fully optional. The shareable invite link is the primary
 * path and works with neither `RESEND_API_KEY` nor `EMAIL_FROM` set — this
 * is an enhancement, never a dependency invite creation blocks on.
 * docs/implementation-roadmap.md Phase 2 (deliberate deviation from the
 * roadmap's literal "Resend... sent synchronously" text).
 */
export async function sendInviteEmail(params: {
  to: string;
  workspaceName: string;
  inviterName: string;
  acceptUrl: string;
}): Promise<void> {
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM) {
    return;
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: config.EMAIL_FROM,
        to: params.to,
        subject: `${params.inviterName} invited you to ${params.workspaceName} on wave`,
        html:
          `<p>${escapeHtml(params.inviterName)} invited you to join ` +
          `<strong>${escapeHtml(params.workspaceName)}</strong> on wave.</p>` +
          `<p><a href="${params.acceptUrl}">Accept the invite</a></p>`,
      }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, "invite email send failed");
    }
  } catch (err) {
    // Never blocks or fails invite creation — the link is the real delivery
    // mechanism, this is a courtesy on top of it.
    logger.warn({ err }, "invite email send threw");
  }
}
