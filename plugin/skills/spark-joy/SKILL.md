---
name: spark-joy
description: Break a large PR/MR into small, ordered chunks and open a local app where a human reviews them one at a time; or split the user's own staged, uncommitted or branch changes into small stacked PRs. Use when the user wants help reviewing a big PR, MR or branch, asks to chunk or split a diff for review, asks to split their changes into smaller PRs, or types /spark-joy.
---

# spark-joy

You group a diff into reviewable chunks; the `spark-joy` CLI does the rest. Two modes:
- **Review** (default): someone else's PR, read in chunks. Steps 1–5.
- **Split**: the user's own changes become stacked PRs. Steps 1–3, then [Split mode](#split-mode). The reader is a tired human. **Every word you write is load on them. Be terse.**

Run `spark-joy` inside the repo under review. If it isn't on PATH, ask the user to run `npm install -g @dansyuqri/spark-joy`; don't try other packages. Never edit the code under review. If your sandbox blocks a command (a server that keeps running, or `split --apply` writing to `.git`), give the user the exact command to run instead.

## 1. Extract

```
spark-joy extract [base]    # base: the PR's target; omit to use origin's default. --working for uncommitted
spark-joy outline
```

Every hunk gets an id (`h001`; pieces of a split hunk are `h012.1`). Hunks flagged `lockfile`, `generated`, `binary`, `whitespace-only`, `rename` or `mode` may be left out; they go to skim automatically. If the diff is empty, say so and stop.

## 2. Read

```
spark-joy show h001..h015 | show h007 h012 | show --file src/api.ts
```

Read in batches, never the whole diff at once. Open surrounding source files when you need context.

## 3. Write `.spark-joy/<run>/plan.json`

```json
{
  "title": "Team invitations",
  "overview": "Email invites to teams; expire after 7 days.",
  "strategies": [
    { "id": "layers", "chunks": [
      { "id": "schema", "title": "Invitations table", "intent": "Pending invites; everything reads this.",
        "hunks": ["h004", "h005"], "risk": "med",
        "reviewFocus": ["Unique (team_id, email) blocks re-invites?"] }
    ]},
    { "id": "features", "chunks": [] }
  ],
  "features": [{ "title": "Invite by email", "description": "Admins invite by email; 7-day expiry.", "hunks": ["h004", "h007"] }],
  "skim": ["h020"]
}
```

**Word limits** (`validate` fails over them):

| field | max words |
|---|---|
| title, chunk title | 5 |
| overview | 15 |
| intent | 10 |
| reviewFocus | 2 items × 8 |
| feature title / description | 4 / 8 |
| link label | 3 |

**Style:** every word costs the reviewer. Write like a commit subject; fragments are fine.
- Say what it does or what to watch. Never restate the code.
- Never contrast with what it doesn't do: ~~"Reads hunks by count, not prefix"~~ → "Reads hunks by line count".
- No openers or filler: ~~"This chunk introduces various…"~~.
- Cut every word that doesn't change the meaning.
- `title` names the area. `intent` says what the change achieves. Both are required, even when it feels obvious.
- `reviewFocus` is a question naming what could break, e.g. ~~"Quoted paths"~~ → "Quoted paths with spaces parsed right?". Omit it when nothing is risky.

`validate` rejects contrasts (", not", "rather than", "instead of"), openers and filler words.

**Two strategies, both required.** Each places every non-mechanical hunk exactly once, in a chunk or in `skim`.
- `layers`: dependency order: types/schema → logic → wiring → callers/UI → leftover tests → docs.
- `features`: one chunk per capability, end to end, with shared plumbing first.

**Chunks**
- Size: 100–300 changed lines, never over 400. One idea per chunk.
- A hunk goes with the code it belongs to; pieces of a split hunk may go to different chunks.
- Tests go with the code they cover, unless they're large.
- `dependsOn` may only name earlier chunks.
- `risk`:
  - `high`: auth, security, money, migrations/deletion, concurrency, public API;
  - `med`: behaviour change in shared code;
  - `low`: everything else, and the default.
- `kind`: `core` (the default), `test` or `mechanical`.

**skim** is only for mechanical churn: moves, formatting, import order, version bumps. **Never logic.**

**features** list what the PR does, as a user or caller would see it. Every non-mechanical hunk belongs to at least one feature.

### Links

The app's **Map** draws chunks and, zoomed in, the files of a chunk with arrows for which hunk uses what. The CLI finds those links from imports and names:

```
spark-joy links
```

Add `"links"` to the plan only for the arrows a reviewer must understand, labelled in at most 3 words:

```json
"links": [{ "from": "h012", "to": "h004", "label": "persists via" }]
```

`from` uses `to`. Unlabelled links still show. Add a link the CLI missed only when it's real.

## 4. Validate

```
spark-joy validate
```

Fix every error and re-run until it says `plan ok`. Fix the warnings too.

## 5. Serve

Run `spark-joy serve` in the background. Reply with the URL and one line: what the PR does and the chunk count. Nothing more.

## Split mode

Use it when the user wants their own changes cut into smaller PRs. Extract what they named:

```
spark-joy extract --staged        # staged only
spark-joy extract --uncommitted   # staged + unstaged
spark-joy extract [base]          # the whole branch
```

Read the hunks as in step 2, then write the plan with `"mode": "split"` and one strategy, `split`:

```json
{
  "mode": "split",
  "title": "Team invitations",
  "strategies": [{ "id": "split", "chunks": [
    { "id": "schema", "title": "Invitations table", "intent": "Store pending invites.", "hunks": ["h004", "h005", "h020"] },
    { "id": "api", "title": "Invite endpoint", "intent": "Admins invite by email.", "hunks": ["h007"], "dependsOn": ["schema"] }
  ]}]
}
```

- Each chunk is one PR, stacked in order: PR 2 is built on PR 1.
- Every hunk goes in a PR, lockfiles included: put each with the change that needs it. There is no skim.
- Each PR must build and pass tests on top of the earlier ones. Never split a function from its callers' update.
- Same word limits and chunk sizes. The title and intent become the commit message and PR text.
- Branches default to `<branch>-split/<n>-<title>`; set `"branch"` on a chunk to override.

Then:

1. `spark-joy validate` until `plan ok`.
2. `spark-joy serve` in the background, so the user can preview the PRs.
3. `spark-joy split`: a dry run that checks the PRs add up to exactly the original changes.
4. If the repo has a fast test command: `spark-joy split --check "<install && test>"`. Each PR runs in a fresh worktree, so include the install step. Fix the plan if a PR fails.
5. Ask the user, then run `spark-joy split --apply`. It creates local branches only and leaves the working tree alone. Reply with the branch list and the path to `prs.md`. Never push.

## After new commits

Re-run `extract`, rewrite the plan from the new `outline`, and validate. The reviewer's progress carries over for unchanged hunks.
