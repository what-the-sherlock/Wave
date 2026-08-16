import Groq from "groq-sdk";
import { config } from "../config/env.js";
import { TokenBucket, consumeWithWait } from "./tokenBucket.js";
import type { LlmProvider, LlmRequest } from "./llmProvider.js";

/**
 * Configured below Groq's published free-tier limit for the default model
 * (30 RPM as of 2026-08 — docs/free-tier-plan.md §4, verified against
 * console.groq.com/docs/models) so normal traffic never hits the bucket's
 * ceiling; a burst is smoothed rather than rejected. A 429 that gets
 * through anyway is left to throw — `ai.process`'s pg-boss queue entry is
 * configured with `retryBackoff: true`, so the retry happens there, not
 * here (docs/free-tier-plan.md §4's "429 → exponential backoff with
 * jitter, retried by the queue rather than surfaced").
 */
const BUCKET_CAPACITY = 20;
const BUCKET_REFILL_PER_MS = BUCKET_CAPACITY / 60_000;

export class GroqProvider implements LlmProvider {
  readonly available = true;
  private readonly client: Groq;
  private readonly bucket = new TokenBucket(BUCKET_CAPACITY, BUCKET_REFILL_PER_MS);

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Groq({ apiKey });
  }

  async complete(req: LlmRequest): Promise<string> {
    let text = "";
    for await (const delta of this.stream(req)) {
      text += delta;
    }
    return text;
  }

  async *stream(req: LlmRequest): AsyncIterable<string> {
    await consumeWithWait(this.bucket);
    const completion = await this.client.chat.completions.create({
      model: this.model,
      max_tokens: req.maxTokens,
      stream: true,
      ...(req.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
      messages: [
        { role: "system", content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    });
    for await (const chunk of completion) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) yield delta;
    }
  }
}

/** Constructed once in server.ts when `GROQ_API_KEY` is set; otherwise the
 * `llmProvider.ts` default (`unavailableLlmProvider`) stays active and every
 * AI feature degrades to a clear 503 rather than crashing. */
export function createGroqProviderFromConfig(): GroqProvider | undefined {
  if (!config.GROQ_API_KEY) return undefined;
  return new GroqProvider(config.GROQ_API_KEY, config.GROQ_MODEL);
}
