import { sql } from "drizzle-orm";
import { withServiceRoleScope } from "../../db/rlsScope.js";
import { logger } from "../../logging/logger.js";
import * as uploadRepo from "../../uploads/upload.repository.js";
import * as storageClient from "./storageAdminClient.js";

/** docs/free-tier-plan.md §8 — the free Supabase project's hard ceiling is
 * 500MB; this is an early warning, not enforcement (full gauges/enforcement
 * land in Phase 8's /stats page). */
const DB_SIZE_WARN_BYTES = 500 * 1024 * 1024;

/** Faster reclaim on a 1GB free storage tier than the roadmap's general
 * default — docs/free-tier-plan.md §8. */
const ORPHAN_ATTACHMENT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

async function deleteOrphanedAttachments(): Promise<void> {
  await withServiceRoleScope(async (tx) => {
    const orphans = await uploadRepo.findOrphansOlderThan(tx, new Date(Date.now() - ORPHAN_ATTACHMENT_MAX_AGE_MS));
    if (orphans.length === 0) return;

    for (const orphan of orphans) {
      await storageClient.deleteObjectAsServiceRole(orphan.storagePath);
      if (orphan.thumbPath) {
        await storageClient.deleteObjectAsServiceRole(orphan.thumbPath);
      }
    }
    await uploadRepo.deleteByIds(tx, orphans.map((o) => o.id));
    logger.info({ count: orphans.length }, "cleaned up orphaned attachments");
  });
}

async function warnIfDatabaseSizeAboveGuard(): Promise<void> {
  await withServiceRoleScope(async (tx) => {
    const [row] = (
      await tx.execute<{ bytes: number }>(sql`select pg_database_size(current_database()) as bytes`)
    ).rows;
    if (row && Number(row.bytes) > DB_SIZE_WARN_BYTES) {
      logger.warn(
        { bytes: Number(row.bytes) },
        "database size above 500MB free-tier guard threshold — see docs/free-tier-plan.md §8; " +
          "full enforcement lands in Phase 8",
      );
    }
  });
}

/**
 * Runs hourly (scheduled in queue/pgBossQueue.ts's start()). Two
 * independent steps share one job purely because both are cheap, infrequent
 * housekeeping.
 */
export async function cleanupOrphansHandler(): Promise<void> {
  await deleteOrphanedAttachments();
  await warnIfDatabaseSizeAboveGuard();
}
