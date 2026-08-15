// Must be the first import: ES module imports are hoisted and evaluated in
// declaration order, so this side-effecting import (it calls
// `dotenv.config()` itself) has to run to completion before anything else
// — including `./server.js`, which transitively imports `config/env.js`
// and validates `process.env` eagerly at import time — gets evaluated.
// Safe in production too: if no `.env` file exists (the normal case on a
// host that injects env vars directly), this is a silent no-op.
import "dotenv/config";

import { startServer } from "./server.js";

startServer();
