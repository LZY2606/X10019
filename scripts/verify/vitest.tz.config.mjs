import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const root = fileURLToPath(new URL("../..", import.meta.url))

export default defineConfig({
  root,
  test: {
    globalSetup: ["./scripts/verify/tz-global-setup.mjs"],
    setupFiles: ["./scripts/verify/tz-worker-setup.mjs"],
  },
})
