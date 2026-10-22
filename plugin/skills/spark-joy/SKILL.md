---
name: spark-joy
description: Break a large PR/MR into small, ordered chunks and open a local app where a human reviews them one at a time; or load an existing stack of PRs/MRs for review, one PR per chunk, and break its PRs into chunks; or split the user's own staged, uncommitted or branch changes into small stacked PRs; or post the reviewer's own notes to the PR or MR as a pending GitHub review or GitLab draft notes. Use when the user wants help reviewing a big PR, MR or branch, or a stack of PRs or MRs, asks to chunk or split a diff for review, asks to split their changes into smaller PRs, asks to post their review notes as PR comments, or types /spark-joy.
---

# spark-joy

You group a diff into reviewable chunks; the `spark-joy` CLI does the rest. Two modes, plus one follow-up:
- **Review** (default): someone else's PR, read in chunks. Steps 1–5.
- **Split**: the user's own changes become stacked PRs. Steps 1–3, then [Split mode](#split-mode).
- **Stack**: existing stacked PRs or MRs on GitHub or GitLab, one chunk per PR. [Stacked PRs](#stacked-prs).
- **Post notes**: the reviewer's own notes go to the PR or MR as a pending review. [Step 7](#7-post-the-reviewers-notes-only-when-asked).

The reader is a tired human. **Every word you write is load on them. Be terse.**

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

## 3. Agree risk with the user

Risk is subjective, so agree what counts as risky before labelling anything.

```
spark-joy rubric
```

- If it prints a rubric that covers what this PR touches, use it.
- Otherwise propose one: at most 2 lines per level, naming areas this repo and PR actually touch. Show it to the user and **wait for them to confirm or edit it**; never assume. Then write `.spark-joy.md` at the repo root and tell the user to commit it, so their team shares it:

```md
# spark-joy
## Risk
- high: auth and permissions, payments, DB migrations
- med: shared utilities, checkout flow
```

## 4. Write `.spark-joy/<run>/plan.json`

```json
{
  "title": "Team invitations",
  "overview": "Email invites to teams; expire after 7 days.",
  "strategies": [
    { "id": "layers", "chunks": [
      { "id": "schema", "title": "Invitations table", "intent": "Pending invites; everything reads this.",
        "hunks": ["h004", "h005"], "risk": "med", "riskReason": "New table on hot query path",
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
| riskReason | 8 |

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
- `risk`: `high` or `med` only when a rubric item applies; `low` (the default) otherwise. Every `high` or `med` chunk needs a `riskReason` naming what it touches and the rubric item, e.g. "Changes session token refresh (auth)".
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

## 5. Validate

```
spark-joy validate
```

Fix every error and re-run until it says `plan ok`. Fix the warnings too.

## 6. Serve

Run `spark-joy serve` in the background. Reply with the URL and one line: what the PR does and the chunk count. Nothing more.

## 7. Post the reviewer's notes (only when asked)

When the user asks to turn their review into PR or MR comments, post **their notes, word for word**. Never add your own findings, never reword, summarise or "improve" a note, and never comment on anything they didn't. If they want more said, they write it in the app.

```
spark-joy comments            # GitHub
spark-joy comments --gitlab   # GitLab
```

It writes `.spark-joy/<run>/comments.json` from the notes saved in the app: line notes on diff lines become inline comments on that line; chunk notes and notes on lines outside the diff go in the review body. If it says there are no notes, tell the user and stop. Post the file unchanged; never edit it.

**GitHub**
1. The commit it prints must be the PR's head (`gh pr view <n> --json headRefOid`). If not, ask the user to re-extract and check their notes still sit on the right lines.
2. Post it as a **pending** review, which only the user sees until they submit it:
   ```
   gh api --method POST repos/<owner>/<repo>/pulls/<n>/reviews --input .spark-joy/<run>/comments.json
   ```
   Without `gh`, use your GitHub tools: create a pending review on the printed commit, then add each comment and the body exactly as they appear in the file.

**GitLab**
1. Each note's `position` SHAs must match the MR's `diff_refs` (`glab mr view <iid> -F json`): `head_sha`, `base_sha` and `start_sha`. If not, ask the user to fetch, re-extract against the MR's target branch and check their notes.
2. Post each entry as a **draft note**, which only the user sees until they submit their review:
   ```
   jq -c '.[]' .spark-joy/<run>/comments.json | while IFS= read -r n; do
     printf '%s' "$n" | glab api --method POST "projects/:fullpath/merge_requests/<iid>/draft_notes" --input -
   done
   ```

Never submit, publish or approve the review. Reply with the PR/MR link, the comment count, and that it stays pending until they submit it.

On other hosts, offer `spark-joy export` for the user to paste.

## Split mode

Use it when the user wants their own changes cut into smaller PRs. Extract what they named:

```
spark-joy extract --staged        # staged only
spark-joy extract --uncommitted   # staged + unstaged
spark-joy extract [base]          # the whole branch
```

Read the hunks as in step 2 and agree risk as in step 3, then write the plan with `"mode": "split"` and one strategy, `split`:

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

## Stacked PRs

Use it when the user wants to review PRs or MRs that are already stacked (each one's base is the branch of the one below). It needs `gh` or `glab`, logged in.

```
spark-joy stack <n or URL>          # any PR in the stack; spark-joy finds the rest
spark-joy stack --prs 12,13,14      # exactly these, bottom first
```

If your sandbox can't reach GitHub or GitLab or keep a server running, give the user one command, `spark-joy stack <n> --serve`: it imports and serves. Then break up the PRs below while it runs; the app picks up the plan when its tab regains focus. "Break up the `<run>` run" means exactly that step.

It fetches each PR's head, diffs it against the PR below it, and writes the plan itself: the `stack` strategy, one chunk per PR, titled and described by the PR. Pass on any `warn` lines (a fork in the stack, a merged PR). You may add `risk`, `riskReason` and `reviewFocus` to its chunks after agreeing risk as in step 3.

**Break up big PRs.** If any PR is over 300 changed lines, or the user asks, add four strategies after `stack`, as in step 4, plus `features`. Read with `outline` and `show` (`--run <run>`).
- `layers` and `features`, PR by PR: each chunk holds hunks of one PR only, and a PR's chunks stay together, bottom PR first. A PR of 300 lines or less is one chunk.
- `stack-layers` and `stack-features`, across PRs: the whole stack's foundations, or one capability end to end, whichever PRs they're in. A chunk may take hunks from several PRs; the app shows each PR's part of a file separately, tagged with its PR. Put a file's hunks from a lower PR before a higher PR's.
- Each PR is diffed against the one below, so line numbers differ between PRs; never treat two PRs' hunks of a file as one change.
- No `skim`: put mechanical hunks in a `mechanical` chunk.
- Leave the `stack` strategy as written. Features may span PRs.

Validate, then `spark-joy serve --run <run>` in the background as in step 6, unless it's already running. Re-importing keeps your additions while the PRs are unchanged; if it warns they changed, plan those strategies again. `comments` doesn't support stacks yet; offer `spark-joy export`.

## After new commits

Re-run `extract`, rewrite the plan from the new `outline`, and validate. The reviewer's progress carries over for unchanged hunks.
