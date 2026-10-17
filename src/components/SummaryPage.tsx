import { useState } from "react";
import {
  chunkNoteKey,
  featureChunks,
  featureHunks,
  hunkStatus,
  notesInHunks,
  progress,
  type StrategyView,
} from "../../shared/derive";
import type { Plan, ReviewState } from "../../shared/schema";
import { exportReview, type RunData } from "../api";
import { routeHref } from "../App";
import { StatusIcon } from "./bits";

interface Props {
  data: RunData;
  plan: Plan;
  view: StrategyView;
  state: ReviewState;
  flush: () => Promise<unknown>;
}

export function SummaryPage({ data, plan, view, state, flush }: Props) {
  const reviewed = new Set(state.reviewed);
  const p = progress(view, reviewed);
  const [exported, setExported] = useState<{ path: string; markdown: string }>();
  const [exportError, setExportError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const chunksWithNotes = view.chunks
    .map((c) => ({
      c,
      note: state.chunkNotes[chunkNoteKey(view.strategy.id, c.chunk.id)]?.trim(),
      lines: notesInHunks(c.hunks, state.lineNotes),
    }))
    .filter((x) => x.note || x.lines.length);
  const noteCount = chunksWithNotes.reduce((n, x) => n + (x.note ? 1 : 0) + x.lines.length, 0);
  const pct = p.linesTotal ? Math.round((100 * p.linesDone) / p.linesTotal) : 100;

  return (
    <main className="page summary-page">
      <p className="totals">
        <strong>
          {p.done}/{p.total}
        </strong>{" "}
        chunks · <strong>{pct}%</strong> lines · <strong>{noteCount}</strong> {noteCount === 1 ? "note" : "notes"}
      </p>

      {plan.features.length > 0 && (
        <>
          <h2>Features</h2>
          <ul className="features">
            {plan.features.map((f) => (
              <li key={f.title} title={f.description}>
                <StatusIcon status={hunkStatus(featureHunks(f, data.hunks), reviewed)} /> {f.title}
                <span className="chunk-refs">
                  {featureChunks(f, view).map((c) => (
                    <a key={c.chunk.id} href={routeHref({ page: "review", chunk: c.index })} title={c.chunk.title}>
                      {c.index + 1}
                    </a>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {chunksWithNotes.length > 0 && (
        <>
          <h2>Notes</h2>
          {chunksWithNotes.map(({ c, note, lines }) => (
            <section key={c.chunk.id} className="note-group">
              <a href={routeHref({ page: "review", chunk: c.index })}>
                {c.index + 1}. {c.chunk.title}
              </a>
              {note && <p className="pre">{note}</p>}
              <ul>
                {lines.map((n) => (
                  <li key={n.id}>
                    <code>
                      {n.file}:{n.line}
                    </code>{" "}
                    {n.text}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}

      <p>
        <button
          className="primary"
          onClick={async () => {
            try {
              await flush();
              setExported(await exportReview());
              setExportError(undefined);
            } catch (e) {
              setExportError((e as Error).message);
            }
          }}
        >
          Export review.md
        </button>{" "}
        {exported && (
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(exported.markdown);
              setCopied(true);
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </p>
      {exportError && <p className="warn">{exportError}</p>}
      {exported && (
        <div className="export">
          <p className="small muted">{exported.path}</p>
          <textarea readOnly value={exported.markdown} />
        </div>
      )}
    </main>
  );
}
