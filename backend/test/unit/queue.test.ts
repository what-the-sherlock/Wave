import { describe, expect, it, vi } from "vitest";
import { getQueue, resetQueue, setQueue } from "../../src/queue/index.js";
import { noopQueue } from "../../src/queue/noopQueue.js";
import type { Queue } from "../../src/queue/queue.js";

describe("queue singleton (getQueue/setQueue/resetQueue)", () => {
  it("defaults to the no-op queue", () => {
    resetQueue();
    expect(getQueue()).toBe(noopQueue);
  });

  it("setQueue swaps the singleton; resetQueue restores the no-op default", () => {
    const fake: Queue = {
      send: vi.fn(),
      sendTx: vi.fn(),
      work: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as Queue;

    setQueue(fake);
    expect(getQueue()).toBe(fake);

    resetQueue();
    expect(getQueue()).toBe(noopQueue);
  });
});

describe("noopQueue", () => {
  it("sendTx never touches the passed transaction — a true no-op, not a deferred call", async () => {
    const tx = { execute: vi.fn() };
    await noopQueue.sendTx(tx as never, "some.queue", { data: 1 });
    expect(tx.execute).not.toHaveBeenCalled();
  });

  it("send/work/start/stop all resolve without throwing", async () => {
    await expect(noopQueue.send("q", { a: 1 })).resolves.toBeUndefined();
    await expect(noopQueue.work("q", async () => undefined)).resolves.toBeUndefined();
    await expect(noopQueue.start()).resolves.toBeUndefined();
    await expect(noopQueue.stop()).resolves.toBeUndefined();
  });
});
