import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { branchName, defaultPrefix, fileSteps, hunkStatus, numberLines, viewFiles, type FileStep, type StrategyView } from "../../shared/derive";
import type { Plan, ReviewState } from "../../shared/schema";
import type { RunData } from "../api";
import { routeHref } from "../App";
import { StatusIcon, plural } from "./bits";

interface Props {
  data: RunData;
  plan: Plan;
  view: StrategyView;
  state: ReviewState;
  path: string;
  // Chunk to start on, usually the one the reader came from.
  at?: number | "skim";
}

// One file's diff in each chunk side by side, so the reader can follow how it
// changes from PR to PR.
export function FilePage({ data, plan, view, state, path, at }: Props) {
  const split = plan.mode === "split";
  const unit = split ? "PR" : "chunk";
  const files = useMemo(() => viewFiles(view), [view]);
  const steps = useMemo(() => fileSteps(view, path), [view, path]);
  const reviewed = new Set(state.reviewed);
  const prefix = defaultPrefix(data.meta.branch);
  const touched = steps.filter((s) => s.hunks.length > 0);
  const start = Math.max(0, steps.findIndex((s) => s.at === (at ?? touched[0]?.at)));

  const track = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState(start);
  // Set while scrolling to a panel, so passing panels don't take focus.
  const moving = useRef(false);
  const show = (i: number, smooth = true) => {
    const el = track.current?.children[i] as HTMLElement | undefined;
    if (!el || !track.current) return;
    moving.current = smooth;
    track.current.scrollTo({ left: el.offsetLeft - track.current.offsetLeft, behavior: smooth ? "smooth" : "auto" });
    setFocus(i);
  };

  useLayoutEffect(() => {
    window.scrollTo(0, 0);
    show(start, false);
  }, [path, start]);

  // Keep the focused panel while it's fully in view; once scrolled out, move
  // focus to the first panel that is. The last panels can't reach the left
  // edge, so focus can't simply follow the left-most one.
  const onScroll = () => {
    const t = track.current;
    if (!t) return;
    const kids = [...t.children] as HTMLElement[];
    const inView = (k: HTMLElement) => {
      const left = k.offsetLeft - t.offsetLeft - t.scrollLeft;
      return left >= -1 && left + k.offsetWidth <= t.clientWidth + 1;
    };
    if (kids[focus] && inView(kids[focus]!)) {
      moving.current = false;
      return;
    }
    if (moving.current) return;
    const i = kids.findIndex(inView);
    if (i >= 0) setFocus(i);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("textarea, input, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "j" || e.key === "ArrowRight") show(Math.min(steps.length - 1, focus + 1));
      else if (e.key === "k" || e.key === "ArrowLeft") show(Math.max(0, focus - 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const name = (s: FileStep) => (s.at === "skim" ? "Skim" : `${unit === "PR" ? "PR" : "Chunk"} ${s.at + 1}`);
  // What the file looks like going into a step: after the last step that touched it.
  const sameAs = (i: number) => {
    const before = steps.slice(0, i).reverse().find((s) => s.hunks.length > 0);
    return before ? `Same as after ${name(before)}.` : "Same as on the base branch.";
  };
  const back = steps[focus]?.at ?? at ?? 0;

  return (
    <main className="page across">
      <header className="across-head">
        <a href={routeHref({ page: "review", chunk: back, file: path })}>← Review</a>
        <select
          aria-label="File"
          value={path}
          onChange={(e) => {
            const s = steps[focus];
            location.hash = routeHref({ page: "file", path: e.target.value, chunk: s?.at });
          }}
        >
          {files.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <span className="muted small">
          Changed in {touched.length} of {plural(steps.length, unit)}
        </span>
      </header>

      <nav className="steps" aria-label={`${unit}s`}>
        <button aria-label="Previous" disabled={focus <= 0} onClick={() => show(focus - 1)}>
          ←
        </button>
        {steps.map((s, i) => (
          <button
            key={String(s.at)}
            className={`step${s.hunks.length ? " touched" : ""}${i === focus ? " on" : ""}`}
            aria-current={i === focus || undefined}
            title={`${name(s)}${s.chunk ? `: ${s.chunk.title}` : ""}${s.hunks.length ? "" : " (no changes)"}`}
            onClick={() => show(i)}
          >
            {s.at === "skim" ? "~" : s.at + 1}
          </button>
        ))}
        <button aria-label="Next" disabled={focus >= steps.length - 1} onClick={() => show(focus + 1)}>
          →
        </button>
      </nav>

      <div
        className="carousel"
        ref={track}
        onScroll={onScroll}
        onWheel={() => (moving.current = false)}
        onPointerDown={() => (moving.current = false)}
      >
        {steps.map((s, i) => {
          const added = s.hunks.reduce((n, h) => n + h.added, 0);
          const removed = s.hunks.reduce((n, h) => n + h.removed, 0);
          return (
            <section key={String(s.at)} className={`file panel${s.hunks.length ? "" : " unchanged"}${i === focus ? " on" : ""}`} aria-label={name(s)}>
              <header>
                <div className="panel-title">
                  {s.hunks.length > 0 && <StatusIcon status={hunkStatus(s.hunks, reviewed)} />}
                  <span className="n">{name(s)}</span>
                  <span className="title">{s.chunk?.title ?? "Mechanical changes"}</span>
                </div>
                <div className="panel-meta small">
                  {split && s.chunk && <code className="branch">{branchName(prefix, (s.at as number) + 1, s.chunk)}</code>}
                  {s.hunks.length > 0 && (
                    <>
                      <span className="counts">
                        <span className="add">+{added}</span> <span className="del">−{removed}</span>
                      </span>
                      <a href={routeHref({ page: "review", chunk: s.at, file: path })}>Open in review</a>
                    </>
                  )}
                </div>
              </header>
              {s.hunks.length === 0 ? (
                <div className="no-change">
                  <strong>No changes in this {unit}</strong>
                  <span className="muted small">{sameAs(i)}</span>
                </div>
              ) : (
                <table>
                  <colgroup>
                    <col className="no-col" />
                    <col className="no-col" />
                    <col />
                  </colgroup>
                  <tbody>
                    {s.hunks.map((h) => (
                      <HunkRows key={h.id} hunk={h} />
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>
      <p className="keys muted small">
        <kbd>j</kbd>/<kbd>k</kbd> or <kbd>←</kbd>/<kbd>→</kbd> move between {unit}s
      </p>
    </main>
  );
}

function HunkRows({ hunk }: { hunk: FileStep["hunks"][number] }) {
  return (
    <>
      <tr className="hunk-header">
        <td colSpan={3}>
          <span className="hid">{hunk.id}</span> {hunk.header}
        </td>
      </tr>
      {hunk.lines.length === 0 && (
        <tr className="placeholder">
          <td colSpan={3}>No text diff.</td>
        </tr>
      )}
      {numberLines(hunk).map((l, i) => (
        <tr key={i} className={`line ${l.kind}`}>
          <td className="no">{l.oldNo ?? ""}</td>
          <td className="no">{l.newNo ?? ""}</td>
          <td className="code">
            <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
            {l.text}
          </td>
        </tr>
      ))}
    </>
  );
}
