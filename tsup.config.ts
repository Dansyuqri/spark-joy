import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "cli/index.ts" },
  format: ["esm"],
  target: "node24",
  platform: "node",
  outDir: "dist",
  clean: false,
  sourcemap: true,
});
