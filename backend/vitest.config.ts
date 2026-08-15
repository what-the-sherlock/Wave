import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    coverage: {
      provider: "v8",
      include: ["src/services/**", "src/**/*.service.ts", "src/middleware/**"],
      reporter: ["text", "html"],
    },
    // Integration tests need a live Supabase stack (local via `supabase
    // start`, or hosted). They self-skip via test/helpers/db.ts when
    // unreachable, so `vitest run` is safe without one running. Timeouts
    // are generous enough for a hosted project over a real network hop —
    // several round trips per test, each ~200-700ms to a remote region,
    // easily exceed a budget tuned for local Docker.
    hookTimeout: 30_000,
    testTimeout: 20_000,
  },
});
