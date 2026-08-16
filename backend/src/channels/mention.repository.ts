import { eq } from "drizzle-orm";
import type { Tx } from "../db/rlsScope.js";
import { messageMentions } from "../db/schema.js";
import type { MessageMention, NewMessageMention } from "../db/schema.js";

export type { MessageMention, NewMessageMention } from "../db/schema.js";

export async function insertMany(tx: Tx, rows: NewMessageMention[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(messageMentions).values(rows);
}

export async function listByMessage(tx: Tx, messageId: string): Promise<MessageMention[]> {
  return tx.select().from(messageMentions).where(eq(messageMentions.messageId, messageId));
}
