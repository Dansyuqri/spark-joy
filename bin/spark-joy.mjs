#!/usr/bin/env node
import { main } from "../dist/cli.js";

main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`spark-joy: ${err?.message ?? err}`);
    process.exit(1);
  },
);
