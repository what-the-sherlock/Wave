import { config } from "../config/env.js";

/**
 * Local embedding, not an API — Groq has no embeddings endpoint, and
 * running the model in-process means indexed message text never leaves our
 * infrastructure (docs/free-tier-plan.md §3, docs/ai-architecture.md §4
 * Rule 6). Same singleton DI shape as `llmProvider.ts`: `server.ts` wires
 * the real Transformers.js-backed implementation, tests inject a fake
 * deterministic embedder so no model download or network call happens in
 * CI.
 */
export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export const EMBEDDING_DIMENSIONS = 384;

/**
 * Wraps `@huggingface/transformers`'s feature-extraction pipeline. Lazy-
 * loaded on first use and kept warm — never at boot — because the model is
 * the largest single memory consumer on a free-tier instance
 * (docs/free-tier-plan.md §3): a process that never embeds anything (an
 * API-only deployment with `RUN_WORKERS=false`) never pays the ~150-250MB
 * RAM cost.
 */
/** The pipeline instance is a callable object at runtime (`extractor(texts,
 * opts)`), but `@huggingface/transformers`' published types only declare the
 * `_call` method the base class actually implements — a known typing gap in
 * that library, not a mistake here. */
type FeatureExtractor = ((
  texts: string[],
  opts: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>) & { _call?: never };

export class TransformersEmbedder implements Embedder {
  private pipelinePromise: Promise<FeatureExtractor> | null = null;

  private async getPipeline(): Promise<FeatureExtractor> {
    this.pipelinePromise ??= (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      const extractor = await pipeline("feature-extraction", config.EMBEDDING_MODEL, { dtype: "q8" });
      return extractor as unknown as FeatureExtractor;
    })();
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    if (!vector) {
      throw new Error("embedder returned no vector");
    }
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getPipeline();
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    return output.tolist();
  }
}

let current: Embedder = new TransformersEmbedder();

export function setEmbedder(embedder: Embedder): void {
  current = embedder;
}

/** Test-only: restores the real (lazy-loading) embedder between test
 * files/suites — tests that want determinism call `setEmbedder` with a
 * fake explicitly, same pattern as `resetQueue`/`resetLlmProvider`. */
export function resetEmbedder(): void {
  current = new TransformersEmbedder();
}

export function getEmbedder(): Embedder {
  return current;
}
