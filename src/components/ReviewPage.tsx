import { useEffect, useMemo } from "react";
import {
  chunkNoteKey,
  hunkStatus,
  notesInHunks,
  setReviewed,
  strategyLabel,
  unitName,
  type StrategyView,
} from "../../shared/derive";
import { fileLinks, mergeLinks, symbolTargets } from "../../shared/graph";
import type { Hunk, LineNote, Plan, ReviewState } from "../../shared/schema";
import type { RunData } from "../api";
import { routeHref, type Update } from "../App";
import { DiffView } from "./DiffView";
import { Kind, PrLink, Risk, StatusIcon, Text, plural } from "./bits";

interface Props {
  data: RunData;
  plan: Plan;
  view: StrategyView;
  state: ReviewState;
  update: Update;
  at: number | "skim";
  // File, or hunk within it, to scroll to when opened from the map or a link.
  file?: string;
  hunk?: string;
}

const go = (at: number | "skim") => {
  location.hash = routeHref({ page: "review", chunk: at });
  window.scrollTo(0, 0);
};

export function ReviewPage({ data, plan, view, state, update, at, file, hunk }: Props) {
  useEffect(() => {
    const el = (hunk && document.getElementById(`hunk-${hunk}`)) || (file && document.getElementById(`file-${file}`));
    if (!el) return;
    // A viewed file starts collapsed; open it so the target can be seen.
    const details = el.closest("details");
    if (details && !details.open) details.open = true;
    el.scrollIntoView({ block: hunk ? "center" : "start" });
  }, [file, hunk, at]);

  const reviewed = new Set(state.reviewed);
  const count = view.chunks.length;
  const hasSkim = view.skim.length > 0;
  const index = at === "skim" ? (hasSkim ? "skim" : Math.max(0, count - 1)) : Math.min(at, Math.max(0, count - 1));
  const current = index === "skim" ? undefined : view.chunks[index];
  const hunks: Hunk[] = index === "skim" ? view.skim : (current?.hunks ?? []);
  const status = hunkStatus(hunks, reviewed);
  const links = useMemo(() => mergeLinks(data.links, plan.links), [data.links, plan.links]);
  const related = useMemo(() => fileLinks(hunks, view, links), [hunks, view, links]);
  const symbols = useMemo(() => symbolTargets(hunks, view, links), [hunks, view, links]);
  const noteKey = current ? chunkNoteKey(view.strategy.id, current.chunk.id) : `${view.strategy.id}/skim`;

  const prev = index === "skim" ? count - 1 : index > 0 ? index - 1 : undefined;
  const next = index === "skim" ? undefined : index < count - 1 ? index + 1 : hasSkim ? "skim" : undefined;

  const toggle = () => update((s) => setReviewed(s, hunks, status !== "done"));
  const markAndNext = () => {
    update((s) => setReviewed(s, hunks, true));
    if (next !== undefined) go(next);
    else location.hash = "#/summary";
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("textarea, input, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "j" || e.key === "ArrowRight") && next !== undefined) go(next);
      else if ((e.key === "k" || e.key === "ArrowLeft") && prev !== undefined && prev >= 0) go(prev);
      else if (e.key === "x") toggle();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const lineNotes = notesInHunks(hunks, state.lineNotes);
  const chunkOf = new Map(view.chunks.flatMap((c) => c.chunk.hunks.map((id) => [id, c.index] as const)));
  const addNote = (n: Omit<LineNote, "id" | "at">) =>
    update((s) => ({
      ...s,
      // In a stack, a line number only means something within its PR.
      lineNotes: [
        ...s.lineNotes,
        { ...n, ...(hunks[0]?.pr !== undefined ? { pr: hunks[0].pr } : {}), id: crypto.randomUUID(), at: new Date().toISOString() },
      ],
    }));
  const editNote = (id: string, text: string) =>
    update((s) => ({
      ...s,
      lineNotes: text.trim()
        ? s.lineNotes.map((n) => (n.id === id ? { ...n, text } : n))
        : s.lineNotes.filter((n) => n.id !== id),
    }));
  const deleteNote = (id: string) => update((s) => ({ ...s, lineNotes: s.lineNotes.filter((n) => n.id !== id) }));

  const fileNames = new Set(hunks.map((h) => h.file));
  const files = fileNames.size;
  const viewedFiles = [...fileNames].filter((f) => hunks.every((h) => h.file !== f || reviewed.has(h.hash))).length;

  return (
    <div className="review">
      <aside className="sidebar">
        <div className="muted small">{strategyLabel(view.strategy)}</div>
        <ol>
          {view.chunks.map((c, i) => (
            <li key={c.chunk.id} className={i === index ? "on" : ""}>
              <a href={routeHref({ page: "review", chunk: i })}>
                <StatusIcon status={hunkStatus(c.hunks, reviewed)} />
                <span className="n">{i + 1}</span>
                <span className="title">{c.chunk.title}</span>
                <Risk risk={c.chunk.risk} reason={c.chunk.riskReason} compact />
                <span className="size">{c.size}</span>
              </a>
            </li>
          ))}
          {hasSkim && (
            <li className={index === "skim" ? "on skim" : "skim"}>
              <a href={routeHref({ page: "review", chunk: "skim" })}>
                <StatusIcon status={hunkStatus(view.skim, reviewed)} />
                <span className="n">~</span>
                <span className="title">Skim</span>
                <span className="size">{view.skim.length}</span>
              </a>
            </li>
          )}
        </ol>
        <p className="keys muted small">
          <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>x</kbd> done · click line # to note
        </p>
      </aside>

      <main className="page chunk">
        <header className="chunk-head">
          <h1>
            <StatusIcon status={status} /> {current ? current.chunk.title : "Skim"}
            {current && <PrLink meta={data.meta} chunk={current.chunk} />}
            {current && <Risk risk={current.chunk.risk} reason={current.chunk.riskReason} />}
            {current && <Kind kind={current.chunk.kind} />}
          </h1>
          {current?.chunk.riskReason && current.chunk.risk !== "low" && (
            <p className={`risk-reason risk-reason-${current.chunk.risk}`}>
              <Text>{current.chunk.riskReason}</Text>
            </p>
          )}
          <div className="muted small">
            {current ? `${index === "skim" ? "" : (index as number) + 1}/${count} · ${current.size} lines · ` : ""}
            {plural(files, "file")}
            {status === "partial" && ` · ${viewedFiles}/${files} viewed`}
          </div>
          {current && plan.mode === "stack" ? (
            // The PR's own description, which can run long.
            <details className="description" open={current.chunk.intent.length <= 400}>
              <summary>Description</summary>
              <p className="intent">
                <Text>{current.chunk.intent}</Text>
              </p>
            </details>
          ) : (
            current && (
              <p className="intent">
                <Text>{current.chunk.intent}</Text>
              </p>
            )
          )}
          {current && current.chunk.reviewFocus.length > 0 && (
            <ul className="focus">
              {current.chunk.reviewFocus.map((q) => (
                <li key={q}>
                  <Text>{q}</Text>
                </li>
              ))}
            </ul>
          )}
        </header>

        <DiffView
          key={`${view.strategy.id}-${index}`}
          hunks={hunks}
          allHunks={data.hunks}
          chunkOf={chunkOf}
          related={related}
          symbols={symbols}
          notes={lineNotes}
          onAdd={addNote}
          onEdit={editNote}
          onDelete={deleteNote}
          reviewed={reviewed}
          onViewed={(hs, on) => update((s) => setReviewed(s, hs, on))}
          collapsed={index === "skim"}
          unit={unitName(plan, data.meta)}
        />

        <footer className="chunk-foot">
          <textarea
            id="chunk-note"
            aria-label="Chunk note"
            rows={1}
            value={state.chunkNotes[noteKey] ?? ""}
            placeholder="Note…"
            onChange={(e) => {
              const text = e.target.value;
              update((s) => ({ ...s, chunkNotes: { ...s.chunkNotes, [noteKey]: text } }));
            }}
          />
          <button
            aria-label="Previous"
            disabled={prev === undefined || prev < 0}
            onClick={() => prev !== undefined && go(prev)}
          >
            ←
          </button>
          <button onClick={toggle} aria-pressed={status === "done"}>
            {status === "done" ? "Undo" : "Done"}
          </button>
          <button className="primary" onClick={markAndNext}>
            {next === undefined ? "Done ✓" : "Done →"}
          </button>
        </footer>
      </main>
    </div>
  );
}
