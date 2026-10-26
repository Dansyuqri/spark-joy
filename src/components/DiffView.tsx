import { Fragment, useState, type ReactNode, type SyntheticEvent } from "react";
import { fileIn, fileSegments, numberLines, type FileSegment, type NumberedLine } from "../../shared/derive";
import type { FileLinks, LinkTarget, RelatedFile } from "../../shared/graph";
import type { Hunk, LineNote, PrKey } from "../../shared/schema";
import { loadFile } from "../api";
import { routeHref } from "../App";

const STEP = 20;

interface Props {
  hunks: Hunk[];
  // Every hunk of the run, to place the shown ones within their files.
  allHunks: Hunk[];
  // Chunk index of each hunk in the current order; missing means skim.
  chunkOf: ReadonlyMap<string, number>;
  // Other files each shown file uses or is used by.
  related?: ReadonlyMap<string, FileLinks>;
  // Per hunk: names it uses that another file defines, and where.
  symbols?: ReadonlyMap<string, ReadonlyMap<string, LinkTarget>>;
  notes: LineNote[];
  onAdd: (n: Omit<LineNote, "id" | "at">) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  // Hashes of reviewed hunks; a file is viewed once all its shown hunks are.
  reviewed: ReadonlySet<string>;
  onViewed: (hunks: Hunk[], on: boolean) => void;
  collapsed?: boolean;
  // What a chunk is called ("PR" in split mode), for the link to the file across chunks.
  unit?: string;
  // Stack mode: names a PR, e.g. "#12", for files of a chunk that spans PRs.
  prLabel?: (n: PrKey) => string;
}

// In a stack, `pr` says which PR's version of the file the line is in.
type Anchor = { file: string; side: "old" | "new"; line: number; pr?: PrKey };
const anchorOf = (file: string, l: NumberedLine, pr: PrKey | undefined): Anchor | undefined => {
  const at = l.kind === "del" ? { side: "old" as const, line: l.oldNo! } : l.newNo !== undefined ? { side: "new" as const, line: l.newNo } : undefined;
  return at && { file, ...at, ...(pr !== undefined ? { pr } : {}) };
};
const same = (a: Anchor, n: Anchor) => a.file === n.file && a.side === n.side && a.line === n.line && a.pr === n.pr;
// Each PR of a stack has its own version of a file, so file state is kept per PR.
const fileKey = (file: string, hs: Hunk[]) => (hs[0]?.pr !== undefined ? `${hs[0].pr}:${file}` : file);

type FileText = string[] | "loading" | "stale" | "error";
type Gap = Extract<FileSegment, { kind: "gap" }>;

// The file must still match the diff, or expanded lines would be misplaced.
function matches(lines: string[], hs: Hunk[]): boolean {
  return hs.every((h) => numberLines(h).every((l) => l.newNo === undefined || lines[l.newNo - 1] === l.text));
}

// Height of the sticky top bar, which file headers stick below.
const TOP = 53;

// After collapsing a file whose header was stuck, bring its header back into view.
function keepInView(e: SyntheticEvent<HTMLDetailsElement>) {
  const el = e.currentTarget;
  if (!el.open && el.getBoundingClientRect().top < TOP) el.scrollIntoView({ block: "start" });
}

const targetHref = (t: LinkTarget) => routeHref({ page: "review", chunk: t.chunk, file: t.file, hunk: t.hunk });
const chunkLabel = (t: LinkTarget) => (t.chunk === "skim" ? "skim" : `chunk ${t.chunk + 1}`);
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

const IDENT = /[A-Za-z_$][\w$]*/g;

// A line's text with the names linked in `targets` turned into links.
function linkSymbols(text: string, targets: ReadonlyMap<string, LinkTarget> | undefined) {
  if (!targets?.size) return text;
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(IDENT)) {
    const t = targets.get(m[0]);
    if (!t) continue;
    out.push(text.slice(last, m.index));
    out.push(
      <a key={m.index} className="symbol" href={targetHref(t)} title={`Defined in ${t.file} (${chunkLabel(t)})`}>
        {m[0]}
      </a>,
    );
    last = m.index! + m[0].length;
  }
  if (!out.length) return text;
  out.push(text.slice(last));
  return out;
}

function RelatedRow({ links }: { links: FileLinks }) {
  const item = (r: RelatedFile) => {
    const why = r.labels.length ? r.labels.join(", ") : r.symbols.join(", ");
    return (
      <a key={r.file} href={targetHref(r)} title={`${r.file}${why ? ` · ${why}` : ""}`}>
        {baseName(r.file)} <span className="where">{chunkLabel(r)}</span>
      </a>
    );
  };
  return (
    <div className="related">
      {links.uses.length > 0 && (
        <span>
          <span className="muted">Uses</span> {links.uses.map(item)}
        </span>
      )}
      {links.usedBy.length > 0 && (
        <span>
          <span className="muted">Used by</span> {links.usedBy.map(item)}
        </span>
      )}
    </div>
  );
}

export function DiffView({ hunks, allHunks, chunkOf, related, symbols, notes, onAdd, onEdit, onDelete, reviewed, onViewed, collapsed, unit = "chunk", prLabel }: Props) {
  const [composing, setComposing] = useState<Anchor>();
  const [texts, setTexts] = useState<Record<string, FileText>>({});
  // Lines revealed in each gap, from its top and from its bottom.
  const [open, setOpen] = useState<Record<string, { top: number; bottom: number }>>({});
  const [whole, setWhole] = useState<Record<string, boolean>>({});
  // Files the reviewer opened or closed; the rest start open unless viewed.
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const shownIds = new Set(hunks.map((h) => h.id));

  const load = async (file: string, hs: Hunk[]) => {
    const k = fileKey(file, hs);
    if (texts[k]) return;
    setTexts((t) => ({ ...t, [k]: "loading" }));
    const text: FileText = await loadFile(file, hs[0]?.pr).then(
      ({ lines }) => (matches(lines, hs) ? lines : "stale"),
      () => "error",
    );
    setTexts((t) => ({ ...t, [k]: text }));
  };
  const reveal = (file: string, hs: Hunk[], key: string, top: number, bottom: number) => {
    void load(file, hs);
    setOpen((o) => {
      const cur = o[key] ?? { top: 0, bottom: 0 };
      return { ...o, [key]: { top: cur.top + top, bottom: cur.bottom + bottom } };
    });
  };

  const contextRow = (n: number, offset: number, text: string) => (
    <tr key={`x${n}`} className="line context expanded">
      <td className="no">{n + offset}</td>
      <td className="no">{n}</td>
      <td className="code">
        <span className="sign"> </span>
        {text}
      </td>
    </tr>
  );

  const gapRows = (file: string, hs: Hunk[], g: Gap, first: boolean) => {
    const fk = fileKey(file, hs);
    const text = texts[fk];
    const lines = Array.isArray(text) ? text : undefined;
    const to = g.to ?? lines?.length;
    if (to !== undefined && to < g.from) return null;
    const key = `${fk}:${g.from}`;
    const size = to === undefined ? undefined : to - g.from + 1;
    const all = whole[fk] && size !== undefined;
    const want = open[key] ?? { top: 0, bottom: 0 };
    const top = all ? size : Math.min(want.top, size ?? want.top);
    const bottom = all ? 0 : Math.min(want.bottom, size === undefined ? 0 : size - top);
    const hidden = size === undefined ? undefined : size - top - bottom;
    const rows = [];
    if (lines) for (let n = g.from; n < g.from + top; n++) rows.push(contextRow(n, g.oldOffset, lines[n - 1]!));
    if (hidden !== 0) {
      const atEnd = g.to === undefined;
      rows.push(
        <tr key={`gap${g.from}`} className="gap-row">
          <td colSpan={3}>
            {text === "stale" || text === "error" ? (
              <span className="muted">
                {text === "stale" ? "File changed since extract; re-run `spark-joy extract`." : "Couldn't load the file."}
              </span>
            ) : (
              <>
                {!first && (
                  <button title="Show lines below the change above" onClick={() => reveal(file, hs, key, STEP, 0)}>
                    ↓ {STEP}
                  </button>
                )}
                {!atEnd && (
                  <button title="Show lines above the change below" onClick={() => reveal(file, hs, key, 0, STEP)}>
                    ↑ {STEP}
                  </button>
                )}
                <button onClick={() => reveal(file, hs, key, Infinity, 0)}>
                  {hidden === undefined ? "Show all" : `Show all ${hidden}`}
                </button>
                {text === "loading" && <span className="muted"> loading…</span>}
              </>
            )}
          </td>
        </tr>,
      );
    }
    if (lines && size !== undefined)
      for (let n = g.from + size - bottom; n <= to!; n++) rows.push(contextRow(n, g.oldOffset, lines[n - 1]!));
    return rows;
  };
  const files: { file: string; hunks: Hunk[] }[] = [];
  for (const h of hunks) {
    const last = files[files.length - 1];
    if (last?.file === h.file && last.hunks[0]!.pr === h.pr) last.hunks.push(h);
    else files.push({ file: h.file, hunks: [h] });
  }

  // A chunk across a stack's PRs shows a file once per PR, each tagged with its PR.
  const mixed = new Set(hunks.map((h) => h.pr)).size > 1;

  return (
    <div className="diff">
      {files.map(({ file, hunks: hs }, fi) => {
        const first = hs[0]!;
        // In a stack each PR has its own diff of the file.
        const fileHunks = allHunks.filter((h) => h.file === file && h.pr === first.pr);
        const segments = fileSegments(fileHunks, shownIds);
        const hasGaps = segments.some((x) => x.kind === "gap");
        const added = hs.reduce((n, h) => n + h.added, 0);
        const removed = hs.reduce((n, h) => n + h.removed, 0);
        const viewed = hs.every((h) => reviewed.has(h.hash));
        const key = `${file}-${fi}`;
        const isOpen = !(shut[key] ?? (collapsed || viewed));
        return (
          <details
            key={key}
            id={`file-${file}`}
            className={viewed ? "file viewed" : "file"}
            open={isOpen}
            onToggle={(e) => {
              const open = e.currentTarget.open;
              if (open !== isOpen) setShut((o) => ({ ...o, [key]: !open }));
              keepInView(e);
            }}
          >
            <summary>
              {prLabel && mixed && first.pr !== undefined && <span className="badge pr">{prLabel(first.pr)}</span>}
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
              {hasGaps && (
                <button
                  className="view-file"
                  onClick={(e) => {
                    e.preventDefault();
                    void load(file, hs);
                    setWhole((w) => ({ ...w, [fileKey(file, hs)]: !w[fileKey(file, hs)] }));
                  }}
                >
                  {whole[fileKey(file, hs)] ? "Diff only" : "View file"}
                </button>
              )}
              <a
                className="across-link"
                href={routeHref({ page: "file", path: fileIn(first), chunk: chunkOf.get(first.id) ?? "skim", ...(mixed && first.pr !== undefined ? { pr: first.pr } : {}) })}
                title={`This file's changes in every ${unit}, side by side`}
                onClick={(e) => e.stopPropagation()}
              >
                Across {unit}s
              </a>
              <label className="viewed-box" title="Mark this file reviewed" onClick={(e) => e.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={viewed}
                  onChange={(e) => {
                    const on = e.target.checked;
                    onViewed(hs, on);
                    setShut((o) => ({ ...o, [key]: on }));
                  }}
                />
                Viewed
              </label>
            </summary>
            {related?.get(file) && <RelatedRow links={related.get(file)!} />}
            <table>
              <colgroup>
                <col className="no-col" />
                <col className="no-col" />
                <col />
              </colgroup>
              <tbody>
                {segments.map((seg, si) =>
                  seg.kind === "gap" ? (
                    <Fragment key={`g${seg.from}`}>{gapRows(file, hs, seg, si === 0)}</Fragment>
                  ) : seg.kind === "foreign" ? (
                    <tr key={seg.hunks[0]!.id} className="foreign-row">
                      <td colSpan={3}>
                        ⋯ {seg.hunks.map((h) => h.id).join(", ")}
                        {chunkOf.has(seg.hunks[0]!.id) ? (
                          <a href={routeHref({ page: "review", chunk: chunkOf.get(seg.hunks[0]!.id)! })}>
                            {" "}
                            in chunk {chunkOf.get(seg.hunks[0]!.id)! + 1}
                          </a>
                        ) : (
                          " in skim"
                        )}
                      </td>
                    </tr>
                  ) : (
                  <Fragment key={seg.hunk.id}>
                    <tr className="hunk-header" id={`hunk-${seg.hunk.id}`}>
                      <td colSpan={3}>
                        <span className="hid">{seg.hunk.id}</span> {seg.hunk.header}
                      </td>
                    </tr>
                    {seg.hunk.lines.length === 0 && (
                      <tr className="placeholder">
                        <td colSpan={3}>No text diff.</td>
                      </tr>
                    )}
                    {numberLines(seg.hunk).map((l, i) => {
                      const anchor = anchorOf(file, l, first.pr);
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
                              {l.kind === "del" ? l.text : linkSymbols(l.text, symbols?.get(seg.hunk.id))}
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
                  ),
                )}
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
