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
import { StatusIcon, Text } from "./bits";

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

  return (
    <main className="page summary-page">
      <section className="totals">
        <div>
          <div className="big">
            {p.done}/{p.total}
          </div>
          <div className="muted">chunks reviewed</div>
        </div>
        <div>
          <div className="big">{p.linesTotal ? Math.round((100 * p.linesDone) / p.linesTotal) : 100}%</div>
          <div className="muted">
            of {p.linesTotal} changed lines
          </div>
        </div>
        <div>
          <div className="big">{state.lineNotes.length + chunksWithNotes.filter((x) => x.note).length}</div>
          <div className="muted">notes</div>
        </div>
      </section>

      {plan.overview && (
        <p className="overview">
          <Text>{plan.overview}</Text>
        </p>
      )}

      <h2>What this PR does</h2>
      {plan.features.length === 0 ? (
        <p className="muted">The plan lists no features.</p>
      ) : (
        <ul className="features">
          {plan.features.map((f) => {
            const status = hunkStatus(featureHunks(f, data.hunks), reviewed);
            const chunks = featureChunks(f, view);
            return (
              <li key={f.title}>
                <StatusIcon status={status} /> <strong>{f.title}</strong>
                <div className="muted">
                  <Text>{f.description}</Text>
                </div>
                <div className="small">
                  {chunks.map((c, i) => (
                    <span key={c.chunk.id}>
                      {i > 0 && " · "}
                      <a href={routeHref({ page: "review", chunk: c.index })}>
                        {c.index + 1}. {c.chunk.title}
                      </a>
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <h2>Notes</h2>
      {chunksWithNotes.length === 0 ? (
        <p className="muted">No notes yet.</p>
      ) : (
        chunksWithNotes.map(({ c, note, lines }) => (
          <section key={c.chunk.id} className="note-group">
            <h3>
              <a href={routeHref({ page: "review", chunk: c.index })}>
                {c.index + 1}. {c.chunk.title}
              </a>
            </h3>
            {note && <p className="pre">{note}</p>}
            <ul>
              {lines.map((n) => (
                <li key={n.id}>
                  <code>
                    {n.file}:{n.line}
                  </code>
                  {n.side === "old" && <span className="muted"> (old)</span>} {n.text}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      <h2>Export</h2>
      <p className="muted">
        Writes <code>review.md</code> to the run folder, ready to paste into a GitHub or GitLab comment.
      </p>
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
      </button>
      {exportError && <p className="warn">{exportError}</p>}
      {exported && (
        <div className="export">
          <p className="small muted">
            Wrote {exported.path}{" "}
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(exported.markdown);
                setCopied(true);
              }}
            >
              {copied ? "Copied" : "Copy markdown"}
            </button>
          </p>
          <textarea readOnly value={exported.markdown} />
        </div>
      )}
    </main>
  );
}
