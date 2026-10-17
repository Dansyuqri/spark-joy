import { defineConfig } from "vitest/config";

export default defineConfig({
  // Browser tests need a built app and Chromium; run them with `npm run test:e2e`.
  test: { include: ["test/**/*.test.ts"], exclude: ["test/e2e/**", "node_modules/**"], testTimeout: 20000 },
});
