import { basename, dirname, extname } from "node:path";
import { isIgnorable } from "../../shared/derive";
import type { AutoLink, Hunk } from "../../shared/schema";

// Declarations that name something another file could use. Deliberately
// loose and language-agnostic: a missed link costs less than a wrong one.
const DECLS = [
  /\b(?:function\*?|class|interface|type|enum|def|fn|struct|trait|func|module|object|record)\s+([A-Za-z_$][\w$]*)/g,
  /\bfunc\s+\([^)]*\)\s*([A-Za-z_]\w*)/g, // Go methods
];
// Top-level bindings only; indented consts are locals.
const TOP_BINDING = /^(?:export\s+(?:default\s+)?)?(?:const|let|var|val)\s+([A-Za-z_$][\w$]*)/;
const IDENT = /[A-Za-z_$][\w$]*/g;

const KEYWORDS = new Set(
  (
    "and any as async await bool boolean break case catch char class const continue def default del do else enum " +
    "export extends false final finally float fn for from func function get if impl import in int interface is let " +
    "match mod module new nil none not null number object or package private protected pub public return self set " +
    "static str string struct super switch this throw true try type typeof undefined use val var void while with yield " +
    "main init test index value data result error props state"
  ).split(" "),
);

const usable = (name: string) => name.length >= 3 && !KEYWORDS.has(name.toLowerCase());

const CODE = new Set(
  "ts tsx js jsx mjs cjs mts cts py go rs java kt kts swift rb cs php scala c cc cpp h hpp vue svelte ex exs dart".split(" "),
);
const isCode = (file: string) => CODE.has(extname(file).slice(1).toLowerCase());

// Strings and comments mention names without using them.
const stripNoise = (line: string) =>
  line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, " ")
    .replace(/\/\/.*$|#.*$|\/\*.*?\*\//g, " ");

const IMPORT_LINE = /\b(import|from|require|use|include|using)\b/;

// The name a module is imported by: its file stem, or its folder for index files.
function moduleName(file: string): string {
  const stem = basename(file, extname(file));
  return ["index", "mod", "__init__", "main"].includes(stem) ? basename(dirname(file)) : stem;
}

function declared(line: string): string[] {
  if (IMPORT_LINE.test(line)) return []; // `import { type X }` mentions a declaration; it doesn't make one.
  const names: string[] = [];
  for (const re of DECLS) for (const m of line.matchAll(re)) names.push(m[1]!);
  const top = TOP_BINDING.exec(line);
  if (top) names.push(top[1]!);
  return names;
}

// Names a hunk defines or changes the body of: declarations on added lines,
// plus the declaration enclosing the first change (the last one in the
// leading context, else the one git puts in the hunk header).
export function definitions(h: Hunk): string[] {
  const names = new Set<string>();
  const firstChange = h.lines.findIndex((l) => l[0] === "+" || l[0] === "-");
  let enclosing = declared(/^@@ [^@]* @@ ?(.*)$/.exec(h.header)?.[1] ?? "");
  h.lines.forEach((raw, i) => {
    if (raw[0] === "+") declared(raw.slice(1)).forEach((n) => names.add(n));
    else if (raw[0] === " " && i < firstChange) {
      const d = declared(raw.slice(1));
      if (d.length) enclosing = d;
    }
  });
  if (firstChange >= 0) enclosing.forEach((n) => names.add(n));
  return [...names].filter(usable);
}

function uses(h: Hunk): Set<string> {
  const names = new Set<string>();
  for (const raw of h.lines) if (raw[0] === "+") for (const m of stripNoise(raw.slice(1)).matchAll(IDENT)) names.add(m[0]);
  return names;
}

// Tokens on a file's import lines, so a use only counts when the user file
// actually imports the module that defines the name.
function importTokens(hunks: readonly Hunk[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const h of hunks) {
    const set = out.get(h.file) ?? new Set<string>();
    for (const raw of h.lines) {
      if (raw[0] === "-" || !IMPORT_LINE.test(raw)) continue;
      for (const t of raw.slice(1).split(/[^A-Za-z0-9_$-]+/)) if (t) set.add(t);
    }
    out.set(h.file, set);
  }
  return out;
}

function connected(user: string, definer: string, imports: Map<string, Set<string>>): boolean {
  if (imports.get(user)?.has(moduleName(definer))) return true;
  // Go files in one package share names without imports.
  return extname(user) === ".go" && extname(definer) === ".go" && dirname(user) === dirname(definer);
}

// Links between hunks in different files: `from` uses a name `to` defines.
export function computeLinks(hunks: readonly Hunk[]): AutoLink[] {
  const live = hunks.filter((h) => !isIgnorable(h) && isCode(h.file));
  const imports = importTokens(live);
  const definedIn = new Map<string, Hunk[]>();
  for (const h of live) for (const name of definitions(h)) definedIn.set(name, [...(definedIn.get(name) ?? []), h]);
  // Names defined in many files are too generic to say anything.
  for (const [name, hs] of definedIn) if (new Set(hs.map((h) => h.file)).size > 2) definedIn.delete(name);

  const links = new Map<string, AutoLink>();
  for (const from of live) {
    for (const name of uses(from)) {
      for (const to of definedIn.get(name) ?? []) {
        if (to.file === from.file || !connected(from.file, to.file, imports)) continue;
        const key = `${from.id}>${to.id}`;
        const link = links.get(key) ?? { from: from.id, to: to.id, symbols: [] };
        link.symbols.push(name);
        links.set(key, link);
      }
    }
  }
  return [...links.values()].map((l) => ({ ...l, symbols: l.symbols.sort() }));
}
