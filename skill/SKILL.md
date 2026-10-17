---
name: spark-joy
description: Break a large PR/MR into small, ordered chunks and open a local app where a human reviews them one at a time. Use when the user wants help reviewing a big PR, MR or branch, asks to chunk or split a diff for review, or types /spark-joy.
---

# spark-joy

You group a branch's diff into reviewable chunks; the `spark-joy` CLI does the rest. The reader is a tired human. **Every word you write is load on them. Be terse.**

Run `spark-joy` inside the repo under review. If it isn't on PATH, ask the user to run `npm install -g github:dansyuqri/spark-joy`; don't try other packages. Never edit the code under review.

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

## 4. Validate

```
spark-joy validate
```

Fix every error and re-run until it says `plan ok`. Fix the warnings too.

## 5. Serve

Run `spark-joy serve` in the background. Reply with the URL and one line: what the PR does and the chunk count. Nothing more.

## After new commits

Re-run `extract`, rewrite the plan from the new `outline`, and validate. The reviewer's progress carries over for unchanged hunks.
