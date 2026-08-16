/**
 * The interface from docs/free-tier-plan.md §4: everything provider-specific
 * lives behind this, so a paid frontier model is a config swap, not a
 * rewrite — "~50 lines and it is what keeps the AI decision reversible."
 * Same singleton DI shape as `queue/index.ts`/`realtime/emitter.ts`:
 * `server.ts` wires in the real `GroqProvider` when `GROQ_API_KEY` is set,
 * tests inject a fake, and the default degrades every AI feature gracefully
 * rather than crashing anything that touches it.
 */
export type LlmMessage = { role: "user" | "assistant"; content: string };

export type LlmRequest = {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  /** Requests strict JSON output (used by the summary features, never by
   * streamed Q&A prose). Providers that don't support it may ignore this
   * and rely on prompt instructions instead. */
  jsonMode?: boolean;
};

export interface LlmProvider {
  /** Whether this provider is actually usable — false for the default
   * unavailable provider when no API key is configured. Checked before
   * anything is queued, so a misconfigured deployment fails fast with a
   * clear 503 rather than a job that silently never completes. */
  readonly available: boolean;
  complete(req: LlmRequest): Promise<string>;
  stream(req: LlmRequest): AsyncIterable<string>;
}

class UnavailableLlmProvider implements LlmProvider {
  readonly available = false;

  async complete(): Promise<string> {
    throw new Error("LlmProvider unavailable — GROQ_API_KEY is not configured");
  }

  async *stream(): AsyncIterable<string> {
    throw new Error("LlmProvider unavailable — GROQ_API_KEY is not configured");
  }
}

export const unavailableLlmProvider: LlmProvider = new UnavailableLlmProvider();

let current: LlmProvider = unavailableLlmProvider;

export function setLlmProvider(provider: LlmProvider): void {
  current = provider;
}

/** Test-only: restores the unavailable default between test files/suites. */
export function resetLlmProvider(): void {
  current = unavailableLlmProvider;
}

export function getLlmProvider(): LlmProvider {
  return current;
}
