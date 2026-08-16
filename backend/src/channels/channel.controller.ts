import type { Request, Response } from "express";
import { asyncHandler } from "../errors/asyncHandler.js";
import * as channelService from "./channel.service.js";
import type { Channel, ChannelMembershipInfo, ChannelPeer } from "./channel.service.js";
import type {
  CreateChannelBody,
  InviteToChannelBody,
  MuteChannelBody,
  OpenDmBody,
  UpdateChannelBody,
} from "./channel.schemas.js";

function toDto(
  channel: Channel,
  membership: ChannelMembershipInfo | null,
  dmPeer: ChannelPeer | null = null,
) {
  return {
    id: channel.id,
    workspaceId: channel.workspaceId,
    name: channel.name,
    type: channel.type,
    topic: channel.topic,
    description: channel.description,
    createdBy: channel.createdBy,
    lastMessageSeq: channel.lastMessageSeq,
    lastMessageAt: channel.lastMessageAt,
    memberCount: channel.memberCount,
    aiExcluded: channel.aiExcluded,
    archivedAt: channel.archivedAt,
    createdAt: channel.createdAt,
    role: membership?.role ?? null,
    lastReadSeq: membership?.lastReadSeq ?? null,
    mutedUntil: membership?.mutedUntil ?? null,
    dmPeer,
  };
}

export const create = asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as CreateChannelBody;
  const result = await channelService.createChannel(req.claims!.sub, req.workspace!.id, body);
  res.status(201).json(toDto(result.channel, result.membership, result.dmPeer));
});

export const list = asyncHandler(async (req: Request, res: Response) => {
  const channels = await channelService.listChannels(req.claims!.sub, req.workspace!.id);
  res.status(200).json(channels.map((c) => toDto(c.channel, c.membership, c.dmPeer)));
});

export const getById = asyncHandler(async (req: Request, res: Response) => {
  res.status(200).json(toDto(req.channel!, req.channel!.membership, req.channel!.dmPeer));
});

export const update = asyncHandler(async (req: Request, res: Response) => {
  const patch = req.body as UpdateChannelBody;
  const channel = await channelService.updateChannelSettings(req.claims!.sub, req.channel!.id, patch);
  res.status(200).json(toDto(channel, req.channel!.membership));
});

export const archive = asyncHandler(async (req: Request, res: Response) => {
  await channelService.archiveChannel(req.claims!.sub, req.channel!.id);
  res.status(204).send();
});

export const join = asyncHandler(async (req: Request, res: Response) => {
  await channelService.joinPublicChannel(req.claims!.sub, req.channel!.id);
  res.status(204).send();
});

export const leave = asyncHandler(async (req: Request, res: Response) => {
  await channelService.leaveChannel(req.claims!.sub, req.channel!.id);
  res.status(204).send();
});

export const inviteMember = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.body as InviteToChannelBody;
  await channelService.inviteToPrivateChannel(req.claims!.sub, req.channel!.id, userId);
  res.status(204).send();
});

export const removeMember = asyncHandler(async (req: Request, res: Response) => {
  await channelService.removeChannelMember(req.claims!.sub, req.channel!.id, req.params.userId!);
  res.status(204).send();
});

export const listMembers = asyncHandler(async (req: Request, res: Response) => {
  const members = await channelService.listMembers(req.claims!.sub, req.channel!.id);
  res.status(200).json(
    members.map((m) => ({
      userId: m.userId,
      fullName: m.fullName,
      avatarUrl: m.avatarUrl,
      role: m.role,
      lastReadSeq: m.lastReadSeq,
      joinedAt: m.joinedAt,
    })),
  );
});

export const updateMyMembership = asyncHandler(async (req: Request, res: Response) => {
  const { mutedUntil } = req.body as MuteChannelBody;
  const membership = await channelService.updateMyMembership(req.claims!.sub, req.channel!.id, {
    mutedUntil,
  });
  res.status(200).json(toDto(req.channel!, membership, req.channel!.dmPeer));
});

export const openDm = asyncHandler(async (req: Request, res: Response) => {
  const { userId } = req.body as OpenDmBody;
  const result = await channelService.getOrCreateDm(req.claims!.sub, req.workspace!.id, userId);
  res.status(200).json(toDto(result.channel, result.membership, result.dmPeer));
});
