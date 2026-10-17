import { headLabel, isIgnorable } from "../../shared/derive";
import type { AutoLink, Hunk, Meta } from "../../shared/schema";

const short = (sha: string) => sha.slice(0, 8);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function describeMeta(meta: Meta): string {
  const { files, hunks, added, removed } = meta.stats;
  return `run ${meta.run}: ${meta.base} (${short(meta.mergeBase)}) → ${headLabel(meta)} on ${meta.branch}\n${files} files, ${hunks} hunks, +${added} −${removed}`;
}

// First changed line that says something, to hint at what a hunk does.
function gist(h: Hunk): string {
  const line =
    h.lines.find((l) => (l[0] === "+" || l[0] === "-") && /[A-Za-z0-9]/.test(l) && l.slice(1).trim().length > 3) ?? "";
  return clip(line.replace(/\s+/g, " ").trim(), 90);
}

const section = (h: Hunk) => /^@@ [^@]* @@ ?(.*)$/.exec(h.header)?.[1]?.trim() ?? "";

export function outline(meta: Meta, hunks: readonly Hunk[]): string {
  const out = [describeMeta(meta)];
  const ignorable = hunks.filter(isIgnorable);
  if (ignorable.length) {
    const a = ignorable.reduce((s, h) => s + h.added, 0);
    const r = ignorable.reduce((s, h) => s + h.removed, 0);
    out.push(`${ignorable.length} mechanical hunks (lockfile/generated/binary/whitespace/rename), +${a} −${r}: may be left out of the plan`);
  }
  let file = "";
  for (const h of hunks) {
    if (h.file !== file) {
      file = h.file;
      const fh = hunks.filter((x) => x.file === file);
      const a = fh.reduce((s, x) => s + x.added, 0);
      const r = fh.reduce((s, x) => s + x.removed, 0);
      const from = h.oldFile && h.oldFile !== h.file ? ` (from ${h.oldFile})` : "";
      out.push("", `${file}${from}  [${h.status}] +${a} −${r}`);
    }
    const flags = h.flags.length ? ` {${h.flags.join(",")}}` : "";
    const sec = section(h);
    const where = /^@@ (.*?) @@/.exec(h.header)?.[1] ?? h.header;
    out.push(`  ${h.id.padEnd(9)} ${where.padEnd(22)} +${h.added} −${h.removed}${flags}${sec ? `  in ${clip(sec, 40)}` : ""}`);
    const g = gist(h);
    if (g) out.push(`            ${g}`);
  }
  return out.join("\n");
}

// Expand "h003..h007" style ranges against the hunk order.
export function expandIds(args: string[], hunks: readonly Hunk[]): string[] {
  const order = hunks.map((h) => h.id);
  const ids: string[] = [];
  for (const arg of args.flatMap((a) => a.split(","))) {
    if (!arg) continue;
    const m = /^(.+)\.\.(.+)$/.exec(arg);
    if (m) {
      const from = order.findIndex((id) => id === m[1] || id.startsWith(`${m[1]}.`));
      const toIdx = order.findLastIndex((id) => id === m[2] || id.startsWith(`${m[2]}.`));
      if (from < 0 || toIdx < 0) throw new Error(`unknown range ${arg}`);
      ids.push(...order.slice(from, toIdx + 1));
    } else {
      // A bare parent id selects all of its pieces.
      const match = order.filter((id) => id === arg || id.startsWith(`${arg}.`));
      if (!match.length) throw new Error(`unknown hunk id ${arg}`);
      ids.push(...match);
    }
  }
  return [...new Set(ids)];
}

export function showHunks(hunks: readonly Hunk[], ids: readonly string[]): string {
  const byId = new Map(hunks.map((h) => [h.id, h]));
  return ids
    .map((id) => {
      const h = byId.get(id)!;
      const flags = h.flags.length ? ` {${h.flags.join(",")}}` : "";
      const head = `=== ${h.id}  ${h.file}  [${h.status}] +${h.added} −${h.removed}${flags}`;
      return [head, h.header, ...h.lines].join("\n");
    })
    .join("\n\n");
}

export function showFile(hunks: readonly Hunk[], file: string): string[] {
  return hunks.filter((h) => h.file === file || h.oldFile === file).map((h) => h.id);
}

// Links grouped by file pair, definer first, for Claude to pick which to label.
export function formatLinks(hunks: readonly Hunk[], links: readonly AutoLink[]): string {
  const file = new Map(hunks.map((h) => [h.id, h.file]));
  const pairs = new Map<string, string[]>();
  for (const l of links) {
    const key = `${file.get(l.to)} → ${file.get(l.from)}`;
    pairs.set(key, [...(pairs.get(key) ?? []), `${clip(l.symbols.join(", "), 60)} (${l.to}→${l.from})`]);
  }
  if (!pairs.size) return "no cross-file links found";
  return [...pairs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pair, items]) => [pair, ...items.map((i) => `    ${i}`)].join("\n"))
    .join("\n");
}
