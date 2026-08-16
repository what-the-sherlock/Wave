import { describe, expect, it } from "vitest";
import {
  filterEligibleRecipients,
  resolveCandidates,
} from "../../src/queue/workers/notificationFanout.worker.js";

describe("resolveCandidates", () => {
  it("a USER mention becomes a MENTION candidate, excluding the sender", () => {
    const candidates = resolveCandidates({
      senderId: "sender",
      channelType: "PUBLIC",
      mentions: [{ kind: "USER", mentionedUserId: "user-a" }],
      channelMemberIds: ["sender", "user-a", "user-b"],
      threadParticipantIds: [],
    });
    expect(candidates).toEqual([{ userId: "user-a", type: "MENTION" }]);
  });

  it("a CHANNEL mention expands to every member except the sender", () => {
    const candidates = resolveCandidates({
      senderId: "sender",
      channelType: "PUBLIC",
      mentions: [{ kind: "CHANNEL", mentionedUserId: null }],
      channelMemberIds: ["sender", "user-a", "user-b"],
      threadParticipantIds: [],
    });
    expect(candidates.map((c) => c.userId).sort()).toEqual(["user-a", "user-b"]);
    expect(candidates.every((c) => c.type === "MENTION")).toBe(true);
  });

  it("a DM with no mention notifies the other participant as type DM", () => {
    const candidates = resolveCandidates({
      senderId: "sender",
      channelType: "DM",
      mentions: [],
      channelMemberIds: ["sender", "other"],
      threadParticipantIds: [],
    });
    expect(candidates).toEqual([{ userId: "other", type: "DM" }]);
  });

  it("a DM WITH a mention does not also produce a redundant DM-type candidate", () => {
    const candidates = resolveCandidates({
      senderId: "sender",
      channelType: "DM",
      mentions: [{ kind: "USER", mentionedUserId: "other" }],
      channelMemberIds: ["sender", "other"],
      threadParticipantIds: [],
    });
    expect(candidates).toEqual([{ userId: "other", type: "MENTION" }]);
  });

  it("thread participants become THREAD_REPLY candidates", () => {
    const candidates = resolveCandidates({
      senderId: "sender",
      channelType: "PUBLIC",
      mentions: [],
      channelMemberIds: ["sender", "user-a", "user-b", "user-c"],
      threadParticipantIds: ["user-a", "user-b"],
    });
    expect(candidates.map((c) => c.userId).sort()).toEqual(["user-a", "user-b"]);
    expect(candidates.every((c) => c.type === "THREAD_REPLY")).toBe(true);
  });

  it("MENTION takes precedence over THREAD_REPLY for the same user — one row, not two", () => {
    const candidates = resolveCandidates({
      senderId: "sender",
      channelType: "PUBLIC",
      mentions: [{ kind: "USER", mentionedUserId: "user-a" }],
      channelMemberIds: ["sender", "user-a"],
      threadParticipantIds: ["user-a"],
    });
    expect(candidates).toEqual([{ userId: "user-a", type: "MENTION" }]);
  });

  it("the sender is never their own candidate, even via @channel or thread authorship", () => {
    const candidates = resolveCandidates({
      senderId: "sender",
      channelType: "PUBLIC",
      mentions: [{ kind: "CHANNEL", mentionedUserId: null }],
      channelMemberIds: ["sender"],
      threadParticipantIds: ["sender"],
    });
    expect(candidates).toEqual([]);
  });
});

describe("filterEligibleRecipients", () => {
  it("excludes users who have muted the channel", () => {
    const candidates = [
      { userId: "user-a", type: "MENTION" as const },
      { userId: "user-b", type: "MENTION" as const },
    ];
    const eligible = filterEligibleRecipients(candidates, new Set(["user-a"]));
    expect(eligible).toEqual([{ userId: "user-b", type: "MENTION" }]);
  });

  it("returns everyone when nobody has muted the channel", () => {
    const candidates = [{ userId: "user-a", type: "DM" as const }];
    expect(filterEligibleRecipients(candidates, new Set())).toEqual(candidates);
  });
});
