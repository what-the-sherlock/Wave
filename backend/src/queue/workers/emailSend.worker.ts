import { sql } from "drizzle-orm";
import { withServiceRoleScope } from "../../db/rlsScope.js";
import { config } from "../../config/env.js";
import { logger } from "../../logging/logger.js";
import type { PresenceStore } from "../../realtime/presence/PresenceStore.js";
import * as notificationRepo from "../../notifications/notification.repository.js";
import * as profileRepo from "../../profiles/profile.repository.js";
import * as channelRepo from "../../channels/channel.repository.js";
import * as workspaceRepo from "../../workspaces/workspace.repository.js";
import { notificationEmailHtml } from "./emailTemplates.js";

type AuthUserEmailRow = { email: string | null };

/**
 * Best-effort, gated on `FEATURE_EMAIL` (shipped off by default —
 * docs/free-tier-plan.md §6). Every early-return here is a legitimate,
 * idempotent no-op: a retried job (or one that raced past its own
 * usefulness) must never send a duplicate email or throw.
 */
export async function emailSendHandler(
  data: { notificationId: string },
  presenceStore: PresenceStore,
): Promise<void> {
  if (!config.RESEND_API_KEY || !config.EMAIL_FROM) return;

  await withServiceRoleScope(async (tx) => {
    const notification = await notificationRepo.findById(tx, data.notificationId);
    if (!notification) return;
    if (notification.emailedAt) return; // already sent — a retry of a completed job
    if (notification.readAt) return; // seen in-app before the delay elapsed
    if (await presenceStore.isOnline(notification.userId)) return;

    const [emailRow] = (
      await tx.execute<AuthUserEmailRow>(sql`select email from auth.users where id = ${notification.userId}`)
    ).rows;
    if (!emailRow?.email) return;

    const [actor, channel, workspace] = await Promise.all([
      notification.actorId ? profileRepo.findById(tx, notification.actorId) : undefined,
      notification.channelId ? channelRepo.findById(tx, notification.channelId) : undefined,
      workspaceRepo.findById(tx, notification.workspaceId),
    ]);

    const deepLinkUrl = workspace
      ? `${config.CORS_ORIGINS[0]}/w/${workspace.slug}${channel ? `/c/${channel.id}` : ""}`
      : config.CORS_ORIGINS[0]!;

    const { subject, html } = notificationEmailHtml({
      type: notification.type,
      actorName: actor?.fullName ?? "Someone",
      channelName: channel?.name ?? null,
      preview: notification.preview,
      deepLinkUrl,
    });

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: config.EMAIL_FROM, to: emailRow.email, subject, html }),
      });
      if (!res.ok) {
        logger.warn({ status: res.status }, "notification email send failed");
      }
    } catch (err) {
      // Never fails the job — email is best-effort. Swallowed, same as
      // inviteEmail.ts, and emailed_at is still set below so a permanently
      // failing Resend account cannot cause an infinite retry storm.
      logger.warn({ err }, "notification email send threw");
    }

    await notificationRepo.markEmailed(tx, notification.id);
  });
}
