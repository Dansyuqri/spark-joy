<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" width="240" alt="A drawer of neatly folded diffs, one sparking joy">
  </picture>
</p>

<h1 align="center">spark-joy</h1>

<p align="center"><em>Make PRs spark joy again.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@dansyuqri/spark-joy"><img src="https://img.shields.io/npm/v/@dansyuqri/spark-joy?style=flat-square&label=npm" alt="npm version"></a>
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license">
</p>

AI-assisted pull requests are often thousands of lines long, too big to review properly in one go. spark-joy has Claude break a big PR or MR into small, ordered chunks, then opens a local app where you review them one batch at a time. You tick chunks off, leave notes, and finish with a summary of everything the PR changes.

It works from plain git, so it works the same for GitHub, GitLab or anything else. Nothing is posted anywhere; your notes export as markdown you can paste into the PR.

Inspired by [mr-cast](https://github.com/phanshiyu/mr-cast).

## How it works

```
spark-joy extract   →  hunks.json    every hunk of the diff gets an id (h001, h012.1, …)
Claude (the skill)  →  plan.json     hunks grouped into chunks, in two review orders, plus a feature list
spark-joy validate  →  ok / errors   every non-mechanical hunk is in exactly one chunk, sizes are sane
spark-joy serve     →  review app    choose an order, review chunk by chunk, export review.md
```

- **Claude never copies code into the plan.** It refers to hunks by id, and `validate` checks that no change is missing or reviewed twice.
- **Two review orders.** *Foundations first* goes types → logic → callers → tests. *By feature* follows one capability at a time, end to end. You pick one, and can switch later without losing progress.
- **Mechanical changes are separated.** Lockfiles, generated files, binaries, renames and whitespace-only changes go into a collapsed *skim* section.
- **Chunks stay small.** The target is 100–300 changed lines and validation warns above 400. Large hunks are split at function boundaries so they can go into different chunks.
- **Progress survives new commits.** Review state is stored by hunk content, so after a push you re-extract and only new or changed hunks need another look.
- **Map.** Chunks as a graph. Click one to see how its files' diffs link; click a file to review it.
- **Summary.** A *What this PR does* list ties each feature to the chunks that implement it and shows how much of each has been reviewed.

## Install

Requires Node 22 or newer and git. Published on npm as [`@dansyuqri/spark-joy`](https://www.npmjs.com/package/@dansyuqri/spark-joy).

```sh
npm install -g @dansyuqri/spark-joy
spark-joy install-skill            # or --project to install into ./.claude/skills
```

## Use

In Claude Code, inside the repo with the branch checked out:

```
/spark-joy
```

Or say "help me review this PR in chunks". Claude extracts the diff, reads it, writes and validates the plan, and starts the app at http://127.0.0.1:4848.

In the app:

- `j` / `k` move between chunks and `x` toggles reviewed.
- Click a line number to leave a note on that line.
- **Summary → Export review.md** writes a markdown report with progress, notes (including `file:line`) and the feature list.

### Commands

| Command | What it does |
| --- | --- |
| `spark-joy extract [base] [--working]` | Diff `merge-base(base, HEAD)..HEAD` (or the working tree) into a run in `.spark-joy/<branch>/` |
| `spark-joy outline` | Compact list of every file and hunk with sizes and flags |
| `spark-joy show <ids…> \| --file <path>` | Print hunks in full; accepts ranges like `h003..h010` |
| `spark-joy links` | Cross-file links: which hunk uses a name another defines |
| `spark-joy validate [--json]` | Check `plan.json` against the hunks |
| `spark-joy serve [--port n]` | Start the review app |
| `spark-joy export [--stdout]` | Write `review.md` |
| `spark-joy install-skill [--project]` | Install the Claude Code skill |

`base` defaults to `origin/HEAD`, then `origin/main`, `origin/master` or `main`. Runs are stored in `.spark-joy/`, which ignores itself in git.

The plan format is documented in [skill/SKILL.md](skill/SKILL.md), and the schema is in [shared/schema.ts](shared/schema.ts).

## Develop

```sh
npm install
npm run build        # CLI (tsup) and app (Vite)
npm test             # unit and integration tests
npm run test:e2e     # browser walkthrough of the app (Playwright + Chromium)
npm run typecheck
npm run dev:app      # Vite dev server; proxies /api to a running `spark-joy serve`
```

Layout:

- `cli/`: commands, diff parsing, splitting, classification, server.
- `shared/`: schemas, validation and derived state, used by both the CLI and the app.
- `src/`: the React review app.
- `skill/`: the Claude Code skill.
- `test/`: Vitest, with a fixture git repo.
