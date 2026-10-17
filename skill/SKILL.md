---
name: spark-joy
description: Break a large pull request / merge request into small, ordered, reviewable chunks and open a local review app where a human reviews it batch by batch, ticks chunks off, leaves notes, and sees an aggregated summary of everything the PR changes. Use when the user wants help reviewing a big PR/MR or branch, asks to "chunk", "split up" or "walk through" a diff for review, or types /spark-joy.
---

# spark-joy: make a huge PR reviewable

You turn a branch's diff into a **plan**: the same changes grouped into chunks a human can review one sitting at a time, in two alternative orders, plus a list of the features the PR delivers. The `spark-joy` CLI does everything deterministic (diffing, hunk ids, validation, the review app). Your job is the judgement: grouping, ordering and explaining.

Use `spark-joy` if it is on PATH, otherwise `npx -y spark-joy`. Run all commands from inside the repository being reviewed. Never edit the code under review.

## 1. Extract the diff

Work out the base branch the PR/MR targets. If the user named one, use it; otherwise let `extract` pick origin's default branch. Then:

```
spark-joy extract [base]          # or --working for uncommitted changes
spark-joy outline
```

`extract` diffs `merge-base(base, HEAD)..HEAD` and gives every hunk an id (`h001`, and `h012.1`, `h012.2` for pieces of a split large hunk). `outline` lists every file and hunk with its size, flags and first changed line. Hunks flagged `lockfile`, `generated`, `binary`, `whitespace-only`, `rename` or `mode` are mechanical: you may leave them out of the plan and they land in the skim bucket automatically.

If the diff is empty, tell the user and stop.

## 2. Understand the change

Read the hunks before grouping them. Do not try to load the whole diff at once on a big PR:

```
spark-joy show h001..h015         # a range
spark-joy show h007 h012          # specific hunks (a parent id shows all its pieces)
spark-joy show --file src/api.ts  # every hunk of one file
```

Read surrounding source files when a hunk only makes sense in context. Work out: what the PR is for, which pieces everything else builds on (types, schemas, interfaces, config), which changes are user-visible capabilities, and which are pure plumbing or mechanical churn.

## 3. Write the plan

Write `.spark-joy/<run>/plan.json` (the path is printed by `extract`). Shape:

```json
{
  "title": "Add team invitations",
  "overview": "Two or three sentences a reviewer reads first: what the PR does and how it's built.",
  "strategies": [
    {
      "id": "layers",
      "label": "Foundations first",
      "description": "Data model, then logic, then API and UI.",
      "chunks": [
        {
          "id": "schema",
          "title": "Invitation table and model",
          "intent": "Adds the invitations table and its model. Everything else reads and writes through this.",
          "kind": "core",
          "hunks": ["h004", "h005", "h012.1"],
          "dependsOn": [],
          "reviewFocus": ["Is the unique index on (team_id, email) right for re-invites?"],
          "risk": "med"
        }
      ]
    },
    { "id": "features", "label": "By feature", "description": "One user-visible capability at a time.", "chunks": [] }
  ],
  "features": [
    { "title": "Invite by email", "description": "Admins can invite someone to a team by email; the invite expires after 7 days.", "hunks": ["h004", "h007", "h009"] }
  ],
  "skim": ["h020", "h021"]
}
```

### The two strategies

Always write both; the reviewer picks one in the app. Each strategy must place **every non-mechanical hunk exactly once**, in a chunk or in `skim`.

- **`layers`, foundations first:** order by dependency. Types, schemas and config come first, then core logic, then integration (API, jobs, wiring), then call sites and UI, then tests that didn't fit with their code, then docs. A reviewer should never meet a name before the chunk that defines it.
- **`features`, by feature:** one chunk per capability, cutting vertically through the layers, so the reviewer follows one behaviour end to end. Shared plumbing that several features rely on goes first, as its own chunk.

### Chunk rules

- **Size:** aim for 100–300 changed lines; never over 400 (validate warns). One chunk is one idea a reviewer can hold in their head. Split by sub-concern rather than by file count.
- **Cohesion:** a hunk goes with the code it belongs to, not with its neighbours in the file. Split hunks (`h012.1`, `h012.2`) can go to different chunks.
- **Tests:** in `features`, put a feature's tests in its chunk. In `layers`, keep small tests with the code they cover; a large test suite gets its own chunk after the code.
- **`dependsOn`:** ids of earlier chunks the reviewer must understand first. Only earlier chunks; validate rejects forward references.
- **`intent`:** 1–3 sentences on what changes and why. Don't paraphrase the code line by line.
- **`reviewFocus`:** 1–4 specific questions about the risky parts of this chunk, naming the functions or conditions involved, e.g. "Does `retryUpload` stop after the 3rd failure, or loop forever on 4xx?". Never generic ("check for bugs", "verify tests pass").
- **`risk`:** `high` for auth, permissions, security, money, data migrations or deletion, concurrency, and public API contracts; `med` for behaviour changes in shared code; `low` otherwise.
- **`kind`:** `core`, `test`, or `mechanical`.
- **Titles:** short and specific ("Retry failed uploads with backoff", not "Upload changes").

### Skim

`skim` is for hunks that need a glance, not a read: renames and moves, formatting, import reordering, version bumps, regenerated files the tooling didn't flag. **Never put logic in skim**, however small; it's the one place a reviewer is told not to look closely. Validate warns about large non-mechanical skim hunks.

### Features

`features` is the aggregated "what this PR does" that the reviewer sees on the Plan and Summary pages. List the capabilities or behaviour changes a user or another system would notice, plus significant internal changes (a new cache layer, a migration). Each lists the hunks that implement it; a hunk may belong to several features. Every non-mechanical hunk should belong to at least one feature.

## 4. Validate

```
spark-joy validate
```

Fix every error and re-run until it reports `plan ok`. Treat warnings seriously too: split oversized chunks and check the hunks it says aren't linked to a feature. Don't stop at a failing validation.

## 5. Open the review app

Start the server in the background (it runs until stopped):

```
spark-joy serve
```

Give the user the URL it prints (default http://127.0.0.1:4848), with a two-line overview: what the PR does, and how many chunks each order has. In the app they choose an order, review chunk by chunk (`j`/`k` to move, `x` to mark reviewed, click a line number to comment), and export `review.md` from the Summary page to paste into the GitHub or GitLab PR.

## Updating after new commits

When the branch moves, re-run `spark-joy extract`. Hunk ids are reassigned, so `validate` will report unknown or missing ids. Rewrite the plan from the new `outline`, then validate. Review progress is stored by hunk content, so hunks the reviewer already signed off stay signed off; changed ones show as "changed since review". The app reloads the plan when its tab regains focus.
