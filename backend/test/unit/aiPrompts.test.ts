import { describe, expect, it } from "vitest";
import { buildContextBlock, extractCitedMessageIds, stripCitationMarkers } from "../../src/ai/aiPrompts.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

describe("buildContextBlock", () => {
  it("tags each message with its citable id and skips messages with no body", () => {
    const block = buildContextBlock([
      { id: ID_A, seq: 1, senderId: "u1", body: "hello there", createdAt: new Date("2026-01-01") },
      { id: ID_B, seq: 2, senderId: "u2", body: null, createdAt: new Date("2026-01-01") },
    ]);
    expect(block).toContain(`[[msg:${ID_A}]]`);
    expect(block).toContain("hello there");
    expect(block).not.toContain(ID_B);
    expect(block).toContain("<workspace_messages>");
  });
});

describe("extractCitedMessageIds", () => {
  it("extracts every distinct cited id, case-insensitively, deduplicated", () => {
    const text = `We decided this in [[msg:${ID_A}]] and confirmed in [[msg:${ID_B}]] and again [[msg:${ID_A.toUpperCase()}]].`;
    const ids = extractCitedMessageIds(text);
    expect(ids.sort()).toEqual([ID_A, ID_B].sort());
  });

  it("returns an empty array when the model cited nothing", () => {
    expect(extractCitedMessageIds("I don't know based on the given context.")).toEqual([]);
  });
});

describe("stripCitationMarkers", () => {
  it("removes citation markers but keeps the surrounding prose readable", () => {
    const text = `The team decided to ship on Friday [[msg:${ID_A}]].`;
    expect(stripCitationMarkers(text)).toBe("The team decided to ship on Friday .");
  });
});
