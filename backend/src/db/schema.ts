import { pgTable, timestamp, text, uuid } from "drizzle-orm/pg-core";

/**
 * Mirrors supabase/migrations/20260815010000_profiles.sql. Drizzle's schema
 * is the typed *view* of the tables; the SQL migrations are the source of
 * truth for structure, policies, and grants (docs/target-architecture.md §7).
 */
export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey(),
  fullName: text("full_name").notNull(),
  avatarUrl: text("avatar_url"),
  timezone: text("timezone").notNull().default("UTC"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
