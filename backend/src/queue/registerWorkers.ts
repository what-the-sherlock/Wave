import type { Queue } from "./queue.js";
import type { PresenceStore } from "../realtime/presence/PresenceStore.js";
import { notificationFanoutHandler } from "./workers/notificationFanout.worker.js";
import { emailSendHandler } from "./workers/emailSend.worker.js";
import { cleanupOrphansHandler } from "./workers/cleanupOrphans.worker.js";
import { attachmentProcessHandler } from "./workers/attachmentProcess.worker.js";
import { embeddingGenerateHandler } from "../ai/embedding.worker.js";
import { aiProcessHandler } from "../ai/ai.worker.js";

/**
 * Registers every job handler this process runs, behind `RUN_WORKERS=true`
 * (docs/free-tier-plan.md §5). `presenceStore` is threaded through by plain
 * constructor injection rather than a global singleton — it's only needed
 * here, at registration time.
 */
export async function registerWorkers(params: { queue: Queue; presenceStore: PresenceStore }): Promise<void> {
  const { queue, presenceStore } = params;
  await queue.work("notification.fanout", notificationFanoutHandler);
  await queue.work("email.send", (data: { notificationId: string }) => emailSendHandler(data, presenceStore));
  await queue.work("cleanup.orphans", cleanupOrphansHandler);
  await queue.work("attachment.process", attachmentProcessHandler);
  await queue.work("embedding.generate", embeddingGenerateHandler);
  await queue.work("ai.process", aiProcessHandler);
}
