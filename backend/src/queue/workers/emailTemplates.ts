import { escapeHtml } from "../../lib/escapeHtml.js";
import type { Notification } from "../../notifications/notification.repository.js";

export type NotificationEmailParams = {
  type: Notification["type"];
  actorName: string;
  channelName: string | null;
  preview: string | null;
  deepLinkUrl: string;
};

function subjectFor(params: NotificationEmailParams): string {
  switch (params.type) {
    case "MENTION":
      return `${params.actorName} mentioned you${params.channelName ? ` in #${params.channelName}` : ""}`;
    case "DM":
      return `${params.actorName} sent you a message`;
    case "THREAD_REPLY":
      return `${params.actorName} replied in a thread you're following`;
    case "CHANNEL_INVITE":
      return `${params.actorName} added you to a channel`;
    case "WORKSPACE_INVITE":
      return `${params.actorName} invited you to a workspace`;
    case "SYSTEM":
    default:
      return "You have a new notification on wave";
  }
}

export function notificationEmailHtml(params: NotificationEmailParams): { subject: string; html: string } {
  const subject = subjectFor(params);
  const previewHtml = params.preview
    ? `<blockquote style="margin:0;padding:8px 12px;border-left:3px solid #ddd;color:#333;">${escapeHtml(params.preview)}</blockquote>`
    : "";
  const html =
    `<p>${escapeHtml(subject)}.</p>` +
    previewHtml +
    `<p><a href="${params.deepLinkUrl}">Open in wave</a></p>`;
  return { subject, html };
}
