import { useEffect } from "react";
import {
  chunkNoteKey,
  hunkStatus,
  notesInHunks,
  setReviewed,
  strategyLabel,
  type StrategyView,
} from "../../shared/derive";
import type { Hunk, LineNote, Plan, ReviewState } from "../../shared/schema";
import type { RunData } from "../api";
import { routeHref, type Update } from "../App";
import { DiffView } from "./DiffView";
import { Kind, Risk, StatusIcon, Text, plural } from "./bits";

interface Props {
  data: RunData;
  plan: Plan;
  view: StrategyView;
  state: ReviewState;
  update: Update;
  at: number | "skim";
  // File to scroll to, when opened from the map.
  file?: string;
}

const go = (at: number | "skim") => {
  location.hash = routeHref({ page: "review", chunk: at });
  window.scrollTo(0, 0);
};

export function ReviewPage({ plan, view, state, update, at, file }: Props) {
  useEffect(() => {
    if (file) document.getElementById(`file-${file}`)?.scrollIntoView({ block: "start" });
  }, [file, at]);

  const reviewed = new Set(state.reviewed);
  const count = view.chunks.length;
  const hasSkim = view.skim.length > 0;
  const index = at === "skim" ? (hasSkim ? "skim" : Math.max(0, count - 1)) : Math.min(at, Math.max(0, count - 1));
  const current = index === "skim" ? undefined : view.chunks[index];
  const hunks: Hunk[] = index === "skim" ? view.skim : (current?.hunks ?? []);
  const status = hunkStatus(hunks, reviewed);
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
  const addNote = (n: Omit<LineNote, "id" | "at">) =>
    update((s) => ({
      ...s,
      lineNotes: [...s.lineNotes, { ...n, id: crypto.randomUUID(), at: new Date().toISOString() }],
    }));
  const editNote = (id: string, text: string) =>
    update((s) => ({
      ...s,
      lineNotes: text.trim()
        ? s.lineNotes.map((n) => (n.id === id ? { ...n, text } : n))
        : s.lineNotes.filter((n) => n.id !== id),
    }));
  const deleteNote = (id: string) => update((s) => ({ ...s, lineNotes: s.lineNotes.filter((n) => n.id !== id) }));

  const files = new Set(hunks.map((h) => h.file)).size;

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
            {current && <Risk risk={current.chunk.risk} />}
            {current && <Kind kind={current.chunk.kind} />}
          </h1>
          <div className="muted small">
            {current ? `${index === "skim" ? "" : (index as number) + 1}/${count} · ${current.size} lines · ` : ""}
            {plural(files, "file")}
            {status === "partial" && <span className="warn"> · changed since review</span>}
          </div>
          {current && (
            <p className="intent">
              <Text>{current.chunk.intent}</Text>
            </p>
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
          notes={lineNotes}
          onAdd={addNote}
          onEdit={editNote}
          onDelete={deleteNote}
          collapsed={index === "skim"}
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
