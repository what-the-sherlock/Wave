import { createApp } from "../../src/app.js";

/** Fresh Express app per call — no shared mutable state between test files. */
export function makeTestApp() {
  return createApp();
}
