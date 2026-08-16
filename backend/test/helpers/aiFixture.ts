import type { Embedder } from "../../src/ai/embedder.js";
import type { LlmProvider, LlmRequest } from "../../src/ai/llmProvider.js";
import type { Queue, EnqueueOptions } from "../../src/queue/queue.js";
import type { Tx } from "../../src/db/rlsScope.js";
import type { RealtimeEmitter } from "../../src/realtime/emitter.js";

const DIM = 384;

function hashToken(token: string): number {
  let h = 0;
  for (let i = 0; i < token.length; i++) {
    h = (h * 31 + token.charCodeAt(i)) >>> 0;
  }
  return h % DIM;
}

/**
 * Deterministic bag-of-words "embedding" — no model download, no network
 * call, and (unlike a hash of the whole string) two texts sharing words end
 * up with nonzero cosine similarity, which is enough to test that retrieval
 * actually finds relevant content, not just that it respects tenant
 * boundaries (the boundary itself is enforced by RLS + the workspace_id
 * filter, independent of embedding quality — see retrieval.repository.ts).
 */
export function makeFakeEmbedder(): Embedder {
  const embed = (text: string): Promise<number[]> => {
    const vec = new Array<number>(DIM).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    for (const token of tokens) {
      const idx = hashToken(token);
      vec[idx] = (vec[idx] ?? 0) + 1;
    }
    const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
    return Promise.resolve(vec.map((v) => v / norm));
  };
  return {
    embed,
    embedBatch: (texts) => Promise.all(texts.map(embed)),
  };
}

export type FakeLlmScript = (req: LlmRequest) => string;

/** A scriptable fake LlmProvider — `script` receives the full request
 * (system prompt + messages) and returns the complete response text, then
 * chunks it to exercise the streaming path the same way GroqProvider does. */
export function makeFakeLlmProvider(script: FakeLlmScript): LlmProvider {
  return {
    available: true,
    complete: (req) => Promise.resolve(script(req)),
    async *stream(req) {
      const text = script(req);
      const chunkSize = Math.max(1, Math.ceil(text.length / 4));
      for (let i = 0; i < text.length; i += chunkSize) {
        yield text.slice(i, i + chunkSize);
      }
    },
  };
}

export function makeFailingLlmProvider(message = "fake provider failure"): LlmProvider {
  return {
    available: true,
    complete: () => Promise.reject(new Error(message)),
    stream: async function* stream() {
      throw new Error(message);
    },
  };
}

export type CapturedJob = { queueName: string; data: unknown };

/** Records every enqueued job instead of sending it anywhere — tests grab
 * the captured payload and invoke the relevant worker handler directly, the
 * same pattern uploads.test.ts already uses for attachmentProcessHandler. */
export function makeCapturingQueue(): Queue & { jobs: CapturedJob[] } {
  const jobs: CapturedJob[] = [];
  return {
    jobs,
    send<T extends object>(queueName: string, data: T, _opts?: EnqueueOptions) {
      jobs.push({ queueName, data });
      return Promise.resolve();
    },
    sendTx<T extends object>(_tx: Tx, queueName: string, data: T, _opts?: EnqueueOptions) {
      jobs.push({ queueName, data });
      return Promise.resolve();
    },
    work: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

export type CapturedEvent = { room: "user"; targetId: string; event: string; payload: unknown };

/** Records every emit instead of touching a real Socket.IO server — lets a
 * test assert on exactly what an `ai.response.*` payload contained. */
export function makeCapturingEmitter(): RealtimeEmitter & { events: CapturedEvent[] } {
  const events: CapturedEvent[] = [];
  return {
    events,
    toWorkspace: () => undefined,
    toChannel: () => undefined,
    toUser: (userId, event, payload) => {
      events.push({ room: "user", targetId: userId, event, payload });
    },
    evictUserFromWorkspace: () => undefined,
    joinUserToChannel: () => undefined,
    evictUserFromChannel: () => undefined,
  };
}
