import { describe, expect, it, vi } from "vitest";
import type { Socket } from "socket.io";
import { withAck } from "../../src/realtime/ackHandler.js";
import { ForbiddenError } from "../../src/errors/AppError.js";

function fakeSocket(userId?: string): Socket {
  return { data: userId ? { claims: { sub: userId } } : {} } as unknown as Socket;
}

describe("withAck", () => {
  it("acks {ok: true, ...result} on success", async () => {
    const handler = withAck("test.event", async () => ({ value: 42 }));
    const ack = vi.fn();
    await handler(fakeSocket("user-1"), {}, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true, value: 42 });
  });

  it("acks {ok: true} with no extra fields when the handler returns nothing", async () => {
    const handler = withAck("test.event", async () => undefined);
    const ack = vi.fn();
    await handler(fakeSocket("user-1"), {}, ack);
    expect(ack).toHaveBeenCalledWith({ ok: true });
  });

  it("maps a thrown AppError to its code and message, plus a requestId", async () => {
    const handler = withAck("test.event", async () => {
      throw new ForbiddenError("no access to this channel");
    });
    const ack = vi.fn();
    await handler(fakeSocket("user-1"), {}, ack);
    expect(ack).toHaveBeenCalledTimes(1);
    const [response] = ack.mock.calls[0] as [Record<string, unknown>];
    expect(response.ok).toBe(false);
    expect(response.code).toBe("FORBIDDEN");
    expect(response.message).toBe("no access to this channel");
    expect(typeof response.requestId).toBe("string");
  });

  it("never leaks a raw error's message — generic INTERNAL for unexpected errors", async () => {
    const handler = withAck("test.event", async () => {
      throw new Error("a database connection string leaked here");
    });
    const ack = vi.fn();
    await handler(fakeSocket("user-1"), {}, ack);
    const [response] = ack.mock.calls[0] as [Record<string, unknown>];
    expect(response.ok).toBe(false);
    expect(response.code).toBe("INTERNAL");
    expect(response.message).toBe("Something went wrong");
    expect(JSON.stringify(response)).not.toContain("connection string");
  });

  it("never throws even without an ack callback (fire-and-forget events)", async () => {
    const handler = withAck("test.event", async () => {
      throw new ForbiddenError();
    });
    await expect(handler(fakeSocket("user-1"), {}, undefined)).resolves.toBeUndefined();
  });
});
