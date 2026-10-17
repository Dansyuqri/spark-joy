import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "cli/index.ts" },
  format: ["esm"],
  target: "node22",
  platform: "node",
  outDir: "dist",
  clean: false,
  sourcemap: true,
});
