import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { validatePlan } from "../shared/validate";
import { extract } from "./lib/extract";
import { exportMarkdown } from "./lib/export";
import { describeMeta, expandIds, formatLinks, outline, showFile, showHunks } from "./lib/format";
import * as g from "./lib/git";
import { readHunks, readLinks, readMeta, readPlanRaw, readState, resolveRun } from "./lib/runs";
import { serve } from "./lib/server";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

const HELP = `spark-joy: break a huge PR into reviewable chunks

Usage: spark-joy <command> [options]

Commands:
  extract [base]        Diff merge-base(base, HEAD)..HEAD into hunks (base defaults to origin's default branch)
      --working         Diff against the working tree (uncommitted changes) instead of HEAD
      --split-at <n>    Split hunks longer than n lines (default 150)
  outline               Compact per-file, per-hunk overview of the diff
  show <ids...>         Print hunks in full; accepts h003, h003..h010, or a parent id like h012
      --file <path>     Print every hunk of a file
  links                 Cross-file links: which hunk uses a name another hunk defines
  validate              Check plan.json against the hunks
      --json            Machine-readable output
  serve                 Open the review app
      --port <n>        Port to listen on (default 4848)
  export                Write review.md with progress, notes and the feature summary
      --stdout          Print instead of writing the file
  install-skill         Install the Claude Code skill into ~/.claude/skills/spark-joy
      --project         Install into ./.claude/skills/spark-joy instead

Common options:
  --run <name>          Run to use (default: the current branch's run)
  -v, --version         Print the installed version
  -h, --help            Show this help
`;

async function run(cwd: string, name: string | undefined) {
  const root = await g.repoRoot(cwd);
  const branch = await g.currentBranch(root);
  return resolveRun(root, name, branch);
}

export async function main(argv: string[], cwd = process.cwd()): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      run: { type: "string" },
      working: { type: "boolean" },
      "split-at": { type: "string" },
      file: { type: "string" },
      json: { type: "boolean" },
      port: { type: "string" },
      stdout: { type: "boolean" },
      project: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.version) {
    const pkg = JSON.parse(await readFile(join(PKG_ROOT, "package.json"), "utf8"));
    console.log(pkg.version);
    return 0;
  }
  if (!cmd || values.help) {
    console.log(HELP);
    return cmd || values.help ? 0 : 1;
  }

  switch (cmd) {
    case "extract": {
      const splitAt = values["split-at"] ? Number(values["split-at"]) : undefined;
      if (splitAt !== undefined && !(splitAt >= 40)) throw new Error("--split-at must be a number ≥ 40");
      const r = await extract({ cwd, base: rest[0], working: values.working, run: values.run, splitAt });
      console.log(describeMeta(r.meta));
      console.log(`wrote ${r.paths.dir}`);
      if (r.hunks.length === 0) console.log("the diff is empty; nothing to review");
      if (r.untracked.length)
        console.log(`note: ${r.untracked.length} untracked file(s) are not included; \`git add -N <file>\` to include them`);
      if (await readPlanRaw(r.paths)) console.log("note: plan.json already exists and may be stale; run `spark-joy validate`");
      return 0;
    }

    case "outline": {
      const p = await run(cwd, values.run);
      console.log(outline(await readMeta(p), await readHunks(p)));
      return 0;
    }

    case "show": {
      const p = await run(cwd, values.run);
      const hunks = await readHunks(p);
      const ids = values.file ? showFile(hunks, values.file) : expandIds(rest, hunks);
      if (!ids.length) throw new Error(values.file ? `no hunks in ${values.file}` : "pass hunk ids, e.g. `show h001 h004..h009`");
      console.log(showHunks(hunks, ids));
      return 0;
    }

    case "links": {
      const p = await run(cwd, values.run);
      console.log(formatLinks(await readHunks(p), await readLinks(p)));
      return 0;
    }

    case "validate": {
      const p = await run(cwd, values.run);
      const raw = await readPlanRaw(p);
      if (raw === undefined) throw new Error(`no plan yet; write ${p.plan}`);
      const result = validatePlan(raw, await readHunks(p));
      if (values.json) {
        console.log(JSON.stringify({ ok: result.ok, issues: result.issues }, null, 2));
      } else {
        for (const i of result.issues) console.log(`${i.level === "error" ? "error" : "warn "}  ${i.where}: ${i.message}`);
        const errors = result.issues.filter((i) => i.level === "error").length;
        const warnings = result.issues.length - errors;
        console.log(result.ok ? `plan ok (${warnings} warning${warnings === 1 ? "" : "s"})` : `${errors} error(s), ${warnings} warning(s)`);
      }
      return result.ok ? 0 : 1;
    }

    case "serve": {
      const p = await run(cwd, values.run);
      const port = values.port ? Number(values.port) : 4848;
      const s = await serve({ paths: p, appDir: join(PKG_ROOT, "dist", "app"), port });
      console.log(`spark-joy reviewing ${p.name} at ${s.url}  (Ctrl+C to stop)`);
      await new Promise<void>((resolve) => process.once("SIGINT", resolve));
      await s.close();
      return 0;
    }

    case "export": {
      const p = await run(cwd, values.run);
      const raw = await readPlanRaw(p);
      const hunks = await readHunks(p);
      const result = raw === undefined ? undefined : validatePlan(raw, hunks);
      if (!result?.plan) throw new Error("no valid plan to export; run `spark-joy validate`");
      const md = exportMarkdown(await readMeta(p), hunks, result.plan, await readState(p));
      if (values.stdout) process.stdout.write(md);
      else {
        await writeFile(p.review, md);
        console.log(`wrote ${p.review}`);
      }
      return 0;
    }

    case "install-skill": {
      const dir = values.project
        ? join(await g.repoRoot(cwd), ".claude", "skills", "spark-joy")
        : join(homedir(), ".claude", "skills", "spark-joy");
      await mkdir(dir, { recursive: true });
      await copyFile(join(PKG_ROOT, "plugin", "skills", "spark-joy", "SKILL.md"), join(dir, "SKILL.md"));
      console.log(`installed skill to ${dir}; use /spark-joy in Claude Code`);
      return 0;
    }

    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      return 1;
  }
}
