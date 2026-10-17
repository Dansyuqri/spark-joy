import { Fragment, useState } from "react";
import { numberLines, type NumberedLine } from "../../shared/derive";
import type { Hunk, LineNote } from "../../shared/schema";

interface Props {
  hunks: Hunk[];
  notes: LineNote[];
  onAdd: (n: Omit<LineNote, "id" | "at">) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  collapsed?: boolean;
}

type Anchor = { file: string; side: "old" | "new"; line: number };
const anchorOf = (file: string, l: NumberedLine): Anchor | undefined =>
  l.kind === "del" ? { file, side: "old", line: l.oldNo! } : l.newNo !== undefined ? { file, side: "new", line: l.newNo } : undefined;
const same = (a: Anchor, n: Anchor) => a.file === n.file && a.side === n.side && a.line === n.line;

export function DiffView({ hunks, notes, onAdd, onEdit, onDelete, collapsed }: Props) {
  const [composing, setComposing] = useState<Anchor>();
  const files: { file: string; hunks: Hunk[] }[] = [];
  for (const h of hunks) {
    const last = files[files.length - 1];
    if (last?.file === h.file) last.hunks.push(h);
    else files.push({ file: h.file, hunks: [h] });
  }

  return (
    <div className="diff">
      {files.map(({ file, hunks: hs }, fi) => {
        const first = hs[0]!;
        const added = hs.reduce((n, h) => n + h.added, 0);
        const removed = hs.reduce((n, h) => n + h.removed, 0);
        return (
          <details key={`${file}-${fi}`} id={`file-${file}`} className="file" open={!collapsed}>
            <summary>
              <span className="path">{file}</span>
              {first.oldFile && first.oldFile !== file && <span className="muted"> ← {first.oldFile}</span>}
              <span className={`badge st-${first.status}`}>{first.status}</span>
              {first.flags
                .filter((f) => f !== "test" && f !== "docs")
                .map((f) => (
                  <span key={f} className="badge flag">
                    {f}
                  </span>
                ))}
              <span className="counts">
                <span className="add">+{added}</span> <span className="del">−{removed}</span>
              </span>
            </summary>
            <table>
              <colgroup>
                <col className="no-col" />
                <col className="no-col" />
                <col />
              </colgroup>
              <tbody>
                {hs.map((h) => (
                  <Fragment key={h.id}>
                    <tr className="hunk-header">
                      <td colSpan={3}>
                        <span className="hid">{h.id}</span> {h.header}
                      </td>
                    </tr>
                    {h.lines.length === 0 && (
                      <tr className="placeholder">
                        <td colSpan={3}>No text diff.</td>
                      </tr>
                    )}
                    {numberLines(h).map((l, i) => {
                      const anchor = anchorOf(file, l);
                      const lineNotes = anchor ? notes.filter((n) => same(anchor, n)) : [];
                      const isComposing = anchor && composing && same(anchor, composing);
                      return (
                        <Fragment key={i}>
                          <tr className={`line ${l.kind}`}>
                            <td
                              className="no"
                              onClick={() => anchor && setComposing(anchor)}
                              title={anchor ? "Add note" : undefined}
                            >
                              {l.oldNo ?? ""}
                            </td>
                            <td className="no" onClick={() => anchor && setComposing(anchor)}>
                              {l.newNo ?? ""}
                            </td>
                            <td className="code">
                              <span className="sign">{l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "}</span>
                              {l.text}
                            </td>
                          </tr>
                          {lineNotes.map((n) => (
                            <tr key={n.id} className="note-row">
                              <td colSpan={3}>
                                <NoteBox
                                  initial={n.text}
                                  onSave={(t) => onEdit(n.id, t)}
                                  onDelete={() => onDelete(n.id)}
                                />
                              </td>
                            </tr>
                          ))}
                          {isComposing && (
                            <tr className="note-row">
                              <td colSpan={3}>
                                <NoteBox
                                  initial=""
                                  autoFocus
                                  onSave={(t) => {
                                    if (t.trim()) onAdd({ ...anchor, text: t });
                                    setComposing(undefined);
                                  }}
                                  onDelete={() => setComposing(undefined)}
                                />
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </details>
        );
      })}
    </div>
  );
}

function NoteBox(props: { initial: string; autoFocus?: boolean; onSave: (t: string) => void; onDelete: () => void }) {
  const [text, setText] = useState(props.initial);
  const [editing, setEditing] = useState(!props.initial);
  if (!editing)
    return (
      <div className="line-note">
        <div className="text" onClick={() => setEditing(true)}>
          {props.initial}
        </div>
        <div className="actions">
          <button onClick={() => setEditing(true)}>Edit</button>
          <button onClick={props.onDelete}>Delete</button>
        </div>
      </div>
    );
  const save = () => {
    props.onSave(text);
    if (props.initial) setEditing(false);
  };
  return (
    <div className="line-note editing">
      <textarea
        autoFocus={props.autoFocus}
        value={text}
        placeholder="Line note… (⌘↵ save, Esc cancel)"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
          if (e.key === "Escape") props.initial ? (setText(props.initial), setEditing(false)) : props.onDelete();
        }}
      />
      <div className="actions">
        <button className="primary" onClick={save}>
          Save
        </button>
        <button onClick={() => (props.initial ? (setText(props.initial), setEditing(false)) : props.onDelete())}>
          Cancel
        </button>
      </div>
    </div>
  );
}
