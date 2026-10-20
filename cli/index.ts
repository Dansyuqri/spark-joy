import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultPrefix } from "../shared/derive";
import { RUBRIC_FILE } from "../shared/schema";
import { validatePlan } from "../shared/validate";
import { gitlabDraftNotes, reviewPayload } from "./lib/comments";
import { extract } from "./lib/extract";
import { exportMarkdown } from "./lib/export";
import { describeMeta, expandIds, formatLinks, outline, showFile, showHunks } from "./lib/format";
import * as g from "./lib/git";
import { readHunks, readLinks, readMeta, readPlanRaw, readState, resolveRun } from "./lib/runs";
import { formatRubric, readRubric } from "./lib/rubric";
import { serve } from "./lib/server";
import { buildStack, checkStack, createBranches, prsMarkdown } from "./lib/stack";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

const HELP = `spark-joy: break a huge PR into reviewable chunks

Usage: spark-joy <command> [options]

Commands:
  extract [base]        Diff merge-base(base, HEAD)..HEAD into hunks (base defaults to origin's default branch)
      --working         Diff against the working tree (uncommitted changes) instead of HEAD
      --staged          Only staged changes (HEAD → index); for split
      --uncommitted     Only uncommitted changes (HEAD → working tree); for split
      --split-at <n>    Split hunks longer than n lines (default 150)
  outline               Compact per-file, per-hunk overview of the diff
  show <ids...>         Print hunks in full; accepts h003, h003..h010, or a parent id like h012
      --file <path>     Print every hunk of a file
  links                 Cross-file links: which hunk uses a name another hunk defines
  rubric                Print the agreed risk rubric (.spark-joy.md at the repo root)
  validate              Check plan.json against the hunks
      --json            Machine-readable output
  serve                 Open the review app
      --port <n>        Port to listen on (default 4848)
  export                Write review.md with progress, notes and the feature summary
      --stdout          Print instead of writing the file
  comments              Write comments.json: your notes as a pending GitHub review, word for word
      --gitlab          As GitLab draft notes instead, one request body per note
      --stdout          Print instead of writing the file
  split                 Dry run of a split plan: build the stacked PRs and check they add up
      --check <cmd>     Run cmd on each PR in a temporary worktree, e.g. "npm ci && npm test"
      --apply           Create the branches (never pushes)
      --prefix <name>   Branch prefix (default <branch>-split)
      --force           Move branches that already exist
  install-skill         Install the agent skill for Claude Code (~/.claude/skills) and for
                        Codex, Gemini CLI, Cursor, OpenCode and others (~/.agents/skills)
      --agent <name>    Only one: claude or agents
      --project         Install into the repo (./.claude/skills, ./.agents/skills)
      --print           Print the skill instead, e.g. to paste into AGENTS.md

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
      staged: { type: "boolean" },
      uncommitted: { type: "boolean" },
      apply: { type: "boolean" },
      prefix: { type: "string" },
      force: { type: "boolean" },
      check: { type: "string" },
      agent: { type: "string" },
      print: { type: "boolean" },
      "split-at": { type: "string" },
      file: { type: "string" },
      json: { type: "boolean" },
      port: { type: "string" },
      stdout: { type: "boolean" },
      gitlab: { type: "boolean" },
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
      const flags = (["working", "staged", "uncommitted"] as const).filter((f) => values[f]);
      if (flags.length > 1) throw new Error(`pick one of ${flags.map((f) => `--${f}`).join(", ")}`);
      const r = await extract({ cwd, base: rest[0], source: flags[0], run: values.run, splitAt });
      console.log(describeMeta(r.meta));
      console.log(`wrote ${relative(cwd, r.paths.dir)}`);
      if (r.hunks.length === 0) console.log("the diff is empty; nothing to review");
      if (r.untracked.length)
        console.log(`note: ${r.untracked.length} untracked file(s) are not included; \`git add -N <file>\` to include them`);
      if (await readPlanRaw(r.paths)) console.log("note: plan.json already exists and may be stale; run `spark-joy validate`");
      console.log((await readRubric(r.meta.repoRoot)) ? `risk rubric: ${RUBRIC_FILE}` : "no risk rubric yet");
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

    case "rubric": {
      const rubric = await readRubric(await g.repoRoot(cwd));
      console.log(rubric ? formatRubric(rubric) : `no risk rubric yet; agree one with the user and write ${RUBRIC_FILE}`);
      return 0;
    }

    case "validate": {
      const p = await run(cwd, values.run);
      const raw = await readPlanRaw(p);
      if (raw === undefined) throw new Error(`no plan yet; write ${p.plan}`);
      const result = validatePlan(raw, await readHunks(p));
      const risky = result.plan?.strategies.some((s) => s.chunks.some((c) => c.risk !== "low"));
      if (risky && !(await readRubric(await g.repoRoot(cwd))))
        result.issues.push({ level: "warning", where: "risk", message: `no risk rubric; agree one with the user and write ${RUBRIC_FILE}` });
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
        console.log(`wrote ${relative(cwd, p.review)}`);
      }
      return 0;
    }

    case "comments": {
      const p = await run(cwd, values.run);
      const raw = await readPlanRaw(p);
      const hunks = await readHunks(p);
      const result = raw === undefined ? undefined : validatePlan(raw, hunks);
      if (!result?.plan) throw new Error("no valid plan; run `spark-joy validate`");
      const meta = await readMeta(p);
      const state = await readState(p);
      const review = values.gitlab ? gitlabDraftNotes(meta, hunks, result.plan, state) : reviewPayload(meta, hunks, result.plan, state);
      const inline = Array.isArray(review) ? review.filter((n) => n.position).length : review.comments.length;
      const general = Array.isArray(review) ? review.length > inline : !!review.body;
      if (!inline && !general) throw new Error("no notes yet; leave notes in the review app first");
      const json = JSON.stringify(review, null, 2) + "\n";
      if (values.stdout) {
        process.stdout.write(json);
        return 0;
      }
      await writeFile(p.comments, json);
      console.log(`${inline} inline comment(s)${general ? ", plus notes in the review body" : ""} on ${meta.headSha.slice(0, 7)}`);
      console.log(`wrote ${relative(cwd, p.comments)}`);
      return 0;
    }

    case "split": {
      const p = await run(cwd, values.run);
      const raw = await readPlanRaw(p);
      if (raw === undefined) throw new Error(`no plan yet; write ${p.plan}`);
      const hunks = await readHunks(p);
      const result = validatePlan(raw, hunks);
      if (!result.ok || !result.plan) throw new Error("the plan has errors; run `spark-joy validate`");
      const meta = await readMeta(p);
      const prefix = values.prefix ?? defaultPrefix(meta.branch);
      const stack = await buildStack({
        root: meta.repoRoot,
        meta,
        hunks,
        plan: result.plan,
        prefix,
        indexFile: join(p.dir, "split.index"),
      });
      for (const pr of stack.prs)
        console.log(`${String(pr.n).padStart(2)}  ${pr.branch}  ${pr.lines} lines, ${pr.files} files  ${pr.chunk.title}`);
      console.log(`${stack.prs.length} PRs; the last one matches your changes exactly`);

      if (values.check !== undefined) {
        const tmp = await mkdtemp(join(tmpdir(), "spark-joy-check-"));
        try {
          const results = await checkStack(meta.repoRoot, stack, values.check, tmp);
          for (const r of results) {
            console.log(`PR ${r.n}: ${r.ok ? "passed" : "failed"}`);
            if (!r.ok) console.log(r.output.trimEnd().split("\n").slice(-20).map((l) => `    ${l}`).join("\n"));
          }
          if (results.some((r) => !r.ok)) return 1;
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      }

      await writeFile(p.prs, prsMarkdown(meta, stack));
      if (!values.apply) {
        console.log(`wrote ${relative(cwd, p.prs)}\nnothing created; add --apply to create the branches`);
        return 0;
      }
      await createBranches(meta.repoRoot, stack, !!values.force);
      console.log(`created ${stack.prs.length} branches; your working tree is unchanged. To publish:`);
      for (const pr of stack.prs) console.log(`  git push -u origin ${pr.branch}`);
      console.log(`PR titles and descriptions: ${relative(cwd, p.prs)}`);
      return 0;
    }

    case "install-skill": {
      const skill = join(PKG_ROOT, "plugin", "skills", "spark-joy", "SKILL.md");
      if (values.print) {
        process.stdout.write(await readFile(skill, "utf8"));
        return 0;
      }
      // Claude Code reads .claude/skills; most other agents share .agents/skills.
      const homes: Record<string, string> = { claude: ".claude", agents: ".agents" };
      const agents = values.agent ? [values.agent] : Object.keys(homes);
      const bad = agents.find((a) => !homes[a]);
      if (bad) throw new Error(`unknown agent ${bad}; use claude or agents`);
      const root = values.project ? await g.repoRoot(cwd) : homedir();
      for (const a of agents) {
        const dir = join(root, homes[a]!, "skills", "spark-joy");
        await mkdir(dir, { recursive: true });
        await copyFile(skill, join(dir, "SKILL.md"));
        console.log(`installed skill to ${dir}`);
      }
      console.log('ask your agent to "review this PR in chunks" or "split my changes into PRs"');
      return 0;
    }

    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      return 1;
  }
}
