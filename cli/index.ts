import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultPrefix, prKey, prRef } from "../shared/derive";
import { RUBRIC_FILE, type PrKey } from "../shared/schema";
import { validatePlan } from "../shared/validate";
import { gitlabDraftNotes, reviewPayload, stackDraftNotes, stackReviews, type DraftNote, type ReviewPayload, type StackTarget } from "./lib/comments";
import { extract, extractStack } from "./lib/extract";
import { cliForge, cloneUrl, parsePrArg, parsePrRef, parseRemote, refLabel, refName, relatedLine, relatedRefs, sameRepo, type Forge, type ForgeKind, type Remote } from "./lib/forge";
import { exportMarkdown } from "./lib/export";
import { describeMeta, expandIds, formatLinks, outline, showFile, showHunks } from "./lib/format";
import * as g from "./lib/git";
import { formatNext, postedPath, runStatus, type Step } from "./lib/next";
import { postNotes, type PostTarget } from "./lib/post";
import { readHunks, readLinks, readMeta, readPlanRaw, readState, resolveRun, stackCommentsPath, writeJson, type RunPaths } from "./lib/runs";
import { formatRubric, readRubric } from "./lib/rubric";
import { joinHub } from "./lib/hub";
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
  stack <pr>            Load existing stacked PRs (GitHub) or MRs (GitLab) for review, one chunk per PR.
                        <pr> is a number or URL anywhere in the stack; needs gh or glab, logged in
      --prs <a,b,c>     Exactly these PRs, bottom first, instead of finding the stack
      --remote <name>   Remote the PRs are on (default origin)
      --forge <name>    github or gitlab, when the remote's host doesn't say
  related <pr>          Load a PR or MR and every one it relates to into one review, one chunk per PR.
                        Follows "Relates to #12" lines in descriptions, both ways and onward;
                        each PR is diffed against what it targets. Needs gh or glab, logged in
                        PRs may be in other repos on the same forge: other/repo#4, or a URL
      --prs <a,b,c>     Exactly these PRs instead of following links
      --remote, --forge As for stack
  link <pr> <prs...>    Add "Relates to #b, other/repo#c" to the first PR's description, so \`related\` finds them
      --remote, --forge As for stack
  status                Where the run stands and what to do next
  outline               Compact per-file, per-hunk overview of the diff
  show <ids...>         Print hunks in full; accepts h003, h003..h010, or a parent id like h012
      --file <path>     Print every hunk of a file
  links                 Cross-file links: which hunk uses a name another hunk defines
  rubric                Print the agreed risk rubric (.spark-joy.md at the repo root)
  validate              Check plan.json against the hunks
      --json            Machine-readable output
  serve                 Open the review app; every run served, from any repo, shares one app
      --port <n>        Port to listen on, or join the app already on it (default 4848)
  export                Write review.md with progress, notes and the feature summary
      --stdout          Print instead of writing the file
  comments              Write comments.json: your notes as a pending GitHub review, word for word.
                        For a stack, one comments-<n>.json per PR or MR with notes
      --gitlab          As GitLab draft notes instead, one request body per note
      --stdout          Print instead of writing the file
      --post            Post them through gh or glab as a pending review or draft notes,
                        after checking each PR is still at the commit you reviewed
      --pr <n>          The PR or MR to post to (default: the open one for this branch)
      --force           Post again after an earlier --post
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

Every command ends with a "next:" line: a command to run, or what to ask your agent.

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

// What comes next for the run, printed last by most commands.
async function printNext(p: RunPaths, steps?: Step[]) {
  const next = steps ?? (await runStatus(p)).next;
  if (next.length) console.log(formatNext(next));
}

async function repoRemote(cwd: string, name: string | undefined, forge: string | undefined): Promise<{ remote: Remote; name: string; url: string }> {
  if (forge !== undefined && forge !== "github" && forge !== "gitlab") throw new Error("--forge must be github or gitlab");
  const root = await g.repoRoot(cwd);
  const remoteName = name ?? "origin";
  const url = (await g.git(root, ["remote", "get-url", remoteName]).catch(() => "")).trim();
  if (!url) throw new Error(`no remote named ${remoteName}; pass --remote`);
  return { remote: parseRemote(url, forge as ForgeKind | undefined), name: remoteName, url };
}

// Tests pass a fake forge; otherwise gh or glab is used.
export interface Deps {
  forge?: (remote: Remote) => Forge;
}

export async function main(argv: string[], cwd = process.cwd(), deps: Deps = {}): Promise<number> {
  const makeForge = deps.forge ?? cliForge;
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
      post: { type: "boolean" },
      pr: { type: "string" },
      project: { type: "boolean" },
      prs: { type: "string" },
      remote: { type: "string" },
      forge: { type: "string" },
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
      await printNext(r.paths);
      return 0;
    }

    case "stack":
    case "related": {
      const related = cmd === "related";
      const { remote, name: remoteName, url } = await repoRemote(cwd, values.remote, values.forge);
      // Related PRs may be in other repos on the same forge.
      const parse = (x: string) => (related ? parsePrRef(x, remote) : parsePrArg(x, remote));
      const prs = values.prs?.split(",").filter((x) => x.trim()).map(parse);
      if (!prs?.length && !rest[0]) throw new Error(`pass a PR number or URL, e.g. \`spark-joy ${cmd} 12\`, or --prs 12,13,14`);
      const splitAt = values["split-at"] ? Number(values["split-at"]) : undefined;
      if (splitAt !== undefined && !(splitAt >= 40)) throw new Error("--split-at must be a number ≥ 40");
      const r = await extractStack({
        cwd,
        forge: makeForge(remote),
        forgeFor: makeForge,
        fetchUrl: (r) => cloneUrl(url, remote, r),
        remote: remoteName,
        start: rest[0] ? parse(rest[0]) : undefined,
        prs,
        related,
        run: values.run,
        splitAt,
      });
      for (const w of r.warnings) console.log(`warn  ${w}`);
      r.meta.stack!.prs.forEach((p, i) => {
        const key = prKey(remote.forge, p);
        const hs = r.hunks.filter((h) => h.pr === key);
        const lines = hs.reduce((n, h) => n + h.added + h.removed, 0);
        console.log(`${String(i + 1).padStart(2)}  ${remote.forge === "gitlab" ? "MR" : "PR"} ${prRef(r.meta, key)}  ${p.head} → ${p.base}  ${lines} lines  ${p.title}`);
      });
      console.log(`wrote ${relative(cwd, r.paths.dir)}, with a plan of one chunk per ${remote.forge === "gitlab" ? "MR" : "PR"}`);
      await printNext(r.paths);
      return 0;
    }

    case "link": {
      const { remote } = await repoRemote(cwd, values.remote, values.forge);
      const key = (r: { remote: Remote; number: number }) => `${r.remote.host}/${r.remote.path.toLowerCase()}#${r.number}`;
      const refs = rest.map((x) => parsePrRef(x, remote)).filter((r, i, all) => all.findIndex((o) => key(o) === key(r)) === i);
      const [first, ...others] = refs;
      if (first === undefined || !others.length)
        throw new Error("pass a PR and the PRs it relates to, e.g. `spark-joy link 12 15 other/repo#20`");
      // The description edited is the first PR's, which may be in another repo.
      const forge = makeForge(first.remote);
      const home = first.remote;
      const n = first.number;
      // Fetching each one checks it exists before anything is written.
      const [pr] = await Promise.all(refs.map((r) => (sameRepo(r.remote, home) ? forge : makeForge(r.remote)).get(r.number)));
      const have = new Set(relatedRefs(pr!.body, home).map(key));
      const add = others.filter((r) => !have.has(key(r)));
      const label = refLabel(remote, first);
      if (!add.length) console.log(`${label} already relates to ${others.map((r) => refLabel(home, r)).join(", ")}`);
      else {
        const line = relatedLine(home, add);
        const body = pr!.body.trimEnd();
        await forge.setBody(n, `${body}${body ? "\n\n" : ""}${line}\n`);
        console.log(`${label}  added "${line}" to its description  ${pr!.url}`);
      }
      console.log(formatNext([{ cmd: `related ${refName(remote, first).replace(/^[#!]/, "")}`, why: "load them all into one review" }]));
      return 0;
    }

    case "status": {
      const p = await run(cwd, values.run);
      console.log(describeMeta(await readMeta(p)));
      const s = await runStatus(p);
      for (const l of s.lines) console.log(l);
      await printNext(p, s.next);
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
        if (result.ok) await printNext(p);
      }
      return result.ok ? 0 : 1;
    }

    case "serve": {
      const p = await run(cwd, values.run);
      const port = values.port ? Number(values.port) : 4848;
      const s = await joinHub({
        paths: p,
        appDir: join(PKG_ROOT, "dist", "app"),
        port,
        onChange: ({ hub, home }) => hub && console.log(`the terminal running the app stopped; this one runs it now at ${home}`),
      });
      console.log(`spark-joy reviewing ${p.name} at ${s.url}/  (Ctrl+C to stop)`);
      console.log(s.hub ? `every run you serve shows at ${s.home}` : `joined the app already running; every run shows at ${s.home}`);
      const plan = await readPlanRaw(p).catch(() => undefined);
      const mode = (plan as { mode?: string } | undefined)?.mode;
      const source = (await readMeta(p)).source;
      const after: Step =
        mode === "split"
          ? { cmd: `split --run ${p.name}`, why: "after previewing" }
          : !source || source === "pr" || source === "stack"
            ? { cmd: `comments --post --run ${p.name}`, why: "after leaving notes" }
            : { cmd: `export --run ${p.name}`, why: "after reviewing" };
      console.log(formatNext([after]));
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
      const post = `comments --post --run ${p.name}`;
      if (values.post && !values.force && (await readFile(postedPath(p), "utf8").catch(() => undefined)))
        throw new Error("these notes were already posted; submit or delete that pending review on the forge first, then pass --force");

      // Each PR's notes, and where they go when posted.
      let targets: (PostTarget & { key?: PrKey; url?: string; inline: number; general: boolean })[];
      let remote: Remote;
      if (meta.source === "stack") {
        const st = meta.stack!;
        const forge = st.forge;
        if (values.gitlab && forge !== "gitlab") throw new Error("this stack is on GitHub; drop --gitlab");
        remote = { forge, host: st.host, path: st.repo };
        const home = remote;
        // A related PR in another repo is posted to there.
        const where = (pr: StackTarget) => ({
          key: pr.key,
          ...(pr.repo && { remote: { forge, host: pr.host ?? home.host, path: pr.repo } }),
        });
        targets =
          forge === "gitlab"
            ? stackDraftNotes(meta, hunks, result.plan, state).map(({ pr, notes }) => ({
                ...where(pr),
                number: pr.number,
                url: pr.url,
                headSha: pr.headSha,
                base: pr.mergeBase,
                start: pr.start,
                body: notes,
                inline: notes.filter((n) => n.position).length,
                general: notes.some((n) => !n.position),
              }))
            : stackReviews(meta, hunks, result.plan, state).map(({ pr, review }) => ({
                ...where(pr),
                number: pr.number,
                url: pr.url,
                headSha: pr.headSha,
                base: pr.mergeBase,
                start: pr.start,
                body: review,
                inline: review.comments.length,
                general: !!review.body,
              }));
      } else {
        remote = values.post
          ? (await repoRemote(cwd, values.remote, values.forge ?? (values.gitlab ? "gitlab" : undefined))).remote
          : { forge: values.gitlab ? "gitlab" : "github", host: "", path: "" };
        const body: ReviewPayload | DraftNote[] =
          remote.forge === "gitlab" ? gitlabDraftNotes(meta, hunks, result.plan, state) : reviewPayload(meta, hunks, result.plan, state);
        const inline = Array.isArray(body) ? body.filter((n) => n.position).length : body.comments.length;
        const general = Array.isArray(body) ? body.length > inline : !!body.body;
        targets = inline || general ? [{ number: 0, headSha: meta.headSha, base: meta.mergeBase, start: meta.baseSha, body, inline, general }] : [];
      }
      if (!targets.length) throw new Error("no notes yet; leave notes in the review app first");
      const forgeName = (t: (typeof targets)[number]) => (t.key !== undefined ? `${remote.forge === "gitlab" ? "MR" : "PR"} ${prRef(meta, t.key)}` : "");
      const what = (t: (typeof targets)[number]) =>
        `${t.inline} inline comment(s)${t.general ? `, plus notes in the ${remote.forge === "gitlab" ? "first draft note" : "review body"}` : ""} on ${t.headSha.slice(0, 7)}`;

      if (values.stdout) {
        if (meta.source === "stack")
          process.stdout.write(JSON.stringify(targets.map((t) => ({ number: t.number, ...(t.remote && { repo: t.remote.path }), url: t.url, [remote.forge === "gitlab" ? "notes" : "review"]: t.body })), null, 2) + "\n");
        else process.stdout.write(JSON.stringify(targets[0]!.body, null, 2) + "\n");
        return 0;
      }

      if (values.post) {
        if (meta.source !== "stack") {
          if (meta.source && meta.source !== "pr")
            throw new Error("these notes are on local changes, not a PR; use `spark-joy export` and paste them instead");
          const forge = makeForge(remote);
          let n = values.pr ? parsePrArg(values.pr, remote) : undefined;
          if (n === undefined) {
            const open = (await forge.listOpen()).filter((x) => x.head === meta.branch);
            if (open.length !== 1)
              throw new Error(open.length ? `${open.length} open PRs for ${meta.branch}; pass --pr` : `no open PR for ${meta.branch}; pass --pr`);
            n = open[0]!.number;
          }
          targets[0]!.number = n;
        }
        const posted = await postNotes(makeForge(remote), targets, makeForge);
        for (const x of posted) console.log(`${x.label}  posted ${x.count} pending ${remote.forge === "gitlab" ? "draft note(s)" : "comment(s)"}  ${x.url}`);
        await writeJson(postedPath(p), { at: new Date().toISOString(), prs: targets.map((t) => t.key ?? t.number) });
        console.log(`only you see them until you submit your review on ${remote.forge === "gitlab" ? "GitLab" : "GitHub"}`);
        return 0;
      }

      if (meta.source === "stack") {
        // Files from an earlier run may name PRs that have no notes now.
        for (const f of await readdir(p.dir)) if (/^comments-.+\.json$/.test(f)) await rm(join(p.dir, f));
        for (const t of targets) {
          const file = stackCommentsPath(p, t.key ?? t.number);
          await writeFile(file, JSON.stringify(t.body, null, 2) + "\n");
          console.log(`${forgeName(t)}  ${what(t)}  wrote ${relative(cwd, file)}`);
        }
      } else {
        await writeFile(p.comments, JSON.stringify(targets[0]!.body, null, 2) + "\n");
        console.log(what(targets[0]!));
        console.log(`wrote ${relative(cwd, p.comments)}`);
      }
      if (!meta.source || meta.source === "pr" || meta.source === "stack") await printNext(p, [{ cmd: post }]);
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
      if (meta.source === "stack") throw new Error("this run is stacked PRs that already exist; there is nothing to split");
      const prefix = values.prefix ?? defaultPrefix(meta.branch);
      const stack = await buildStack({
        root: meta.repoRoot,
        meta,
        hunks,
        plan: result.plan,
        prefix,
        indexFile: join(p.dir, "split.index"),
        sign: !!values.apply,
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
        console.log(`wrote ${relative(cwd, p.prs)}\nnothing created yet`);
        await printNext(p, [{ cmd: `split --apply --run ${p.name}`, why: "creates local branches, never pushes" }]);
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
