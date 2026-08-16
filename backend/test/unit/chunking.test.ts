import { describe, expect, it } from "vitest";
import { buildChunkText, isEligibleChannel, isTrivial, type ChunkableMessage } from "../../src/ai/chunking.js";

function msg(overrides: Partial<ChunkableMessage> & { id: string; seq: number }): ChunkableMessage {
  return { body: "placeholder body text", createdAt: new Date("2026-01-01T00:00:00Z"), ...overrides };
}

describe("isTrivial", () => {
  it("null body is trivial", () => {
    expect(isTrivial(null)).toBe(true);
  });
  it("short body (< 15 chars) is trivial", () => {
    expect(isTrivial("ok")).toBe(true);
    expect(isTrivial("thanks!")).toBe(true);
  });
  it("body at or above the threshold is not trivial", () => {
    expect(isTrivial("this is a real message")).toBe(false);
  });
  it("whitespace is trimmed before measuring length", () => {
    expect(isTrivial("   ok   ")).toBe(true);
  });
});

describe("isEligibleChannel", () => {
  it("DMs are never eligible, regardless of ai_excluded", () => {
    expect(isEligibleChannel({ type: "DM", aiExcluded: false })).toBe(false);
  });
  it("an ai_excluded channel is never eligible", () => {
    expect(isEligibleChannel({ type: "PUBLIC", aiExcluded: true })).toBe(false);
  });
  it("a normal public/private channel is eligible", () => {
    expect(isEligibleChannel({ type: "PUBLIC", aiExcluded: false })).toBe(true);
    expect(isEligibleChannel({ type: "PRIVATE", aiExcluded: false })).toBe(true);
  });
});

describe("buildChunkText", () => {
  const base = new Date("2026-01-01T12:00:00Z");

  it("includes the target message's own body", () => {
    const target = msg({ id: "t", seq: 10, body: "the actual message content here", createdAt: base });
    const text = buildChunkText(target, { neighbours: [] });
    expect(text).toContain("the actual message content here");
  });

  it("prepends the thread root's text when the target is a thread reply", () => {
    const target = msg({ id: "reply", seq: 20, body: "sounds good to me", createdAt: base });
    const root = msg({ id: "root", seq: 15, body: "should we ship on Friday?", createdAt: base });
    const text = buildChunkText(target, { threadRoot: root, neighbours: [] });
    expect(text).toContain("Thread: should we ship on Friday?");
    expect(text).toContain("sounds good to me");
  });

  it("includes neighbours within ±3 seq and 5 minutes, excludes ones outside either window", () => {
    const target = msg({ id: "t", seq: 10, body: "yeah lets go with that", createdAt: base });
    const near = msg({ id: "near", seq: 9, body: "I think option B is better", createdAt: base });
    const farBySeq = msg({
      id: "far-seq",
      seq: 5,
      body: "this is from way earlier in the channel",
      createdAt: base,
    });
    const farByTime = msg({
      id: "far-time",
      seq: 11,
      body: "this arrived ten minutes later",
      createdAt: new Date(base.getTime() + 10 * 60_000),
    });
    const text = buildChunkText(target, { neighbours: [target, near, farBySeq, farByTime] });
    expect(text).toContain("I think option B is better");
    expect(text).not.toContain("way earlier in the channel");
    expect(text).not.toContain("ten minutes later");
  });

  it("excludes trivial neighbours ('ok', '👍') from the enriched context", () => {
    const target = msg({ id: "t", seq: 10, body: "what do people think about this proposal", createdAt: base });
    const trivial = msg({ id: "triv", seq: 9, body: "ok", createdAt: base });
    const text = buildChunkText(target, { neighbours: [target, trivial] });
    expect(text).not.toMatch(/^ok$/m);
  });

  it("never duplicates the target message itself as a 'neighbour'", () => {
    const target = msg({ id: "t", seq: 10, body: "the one and only occurrence of this text", createdAt: base });
    const text = buildChunkText(target, { neighbours: [target] });
    expect(text.match(/the one and only occurrence of this text/g)).toHaveLength(1);
  });
});
