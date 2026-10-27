import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "src",
  // Relative asset URLs, so the app also works below a path.
  base: "./",
  plugins: [react()],
  build: { outDir: "../dist/app", emptyOutDir: true },
  server: { proxy: { "/api": "http://127.0.0.1:4848", "^/r/[^/]+/[^/]+/api/": "http://127.0.0.1:4848" } },
});
