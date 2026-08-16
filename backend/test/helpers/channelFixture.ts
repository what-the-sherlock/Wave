import type { Express } from "express";
import { randomUUID } from "node:crypto";
import { createWorkspaceFixture, type WorkspaceFixture } from "./workspaceFixture.js";

export type ChannelDto = {
  id: string;
  workspaceId: string;
  name: string | null;
  type: "PUBLIC" | "PRIVATE" | "DM";
  role: "ADMIN" | "MEMBER" | null;
};

export type ChannelFixture = WorkspaceFixture & { channel: ChannelDto };

/** A fresh workspace (with its owner and #general) plus one additional
 * PUBLIC or PRIVATE channel created by the owner. */
export async function createChannelFixture(
  app: Express,
  type: "PUBLIC" | "PRIVATE" = "PUBLIC",
): Promise<ChannelFixture> {
  const workspace = await createWorkspaceFixture(app);
  const name = `chan-${randomUUID().slice(0, 8)}`;
  const res = await workspace.owner.agent
    .post(`/api/v1/workspaces/${workspace.workspace.id}/channels`)
    .send({ name, type });
  if (res.status !== 201) {
    throw new Error(
      `createChannelFixture: channel creation failed with ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  return { ...workspace, channel: res.body as ChannelDto };
}
