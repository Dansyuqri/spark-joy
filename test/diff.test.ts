import { describe, expect, it } from "vitest";
import { parseDiff, unquotePath } from "../cli/lib/diff";

const d = (...lines: string[]) => lines.join("\n") + "\n";

describe("parseDiff", () => {
  it("parses a modified file with two hunks", () => {
    const [f, ...rest] = parseDiff(
      d(
        "diff --git a/src/a.ts b/src/a.ts",
        "index 111..222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@ function top",
        " one",
        "-two",
        "+TWO",
        " three",
        "@@ -10 +10,2 @@",
        " ten",
        "+eleven",
      ),
    );
    expect(rest).toHaveLength(0);
    expect(f).toMatchObject({ file: "src/a.ts", status: "modified", binary: false });
    expect(f!.oldFile).toBeUndefined();
    expect(f!.hunks).toHaveLength(2);
    expect(f!.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 });
    expect(f!.hunks[0]!.lines).toEqual([" one", "-two", "+TWO", " three"]);
    expect(f!.hunks[1]).toMatchObject({ oldStart: 10, oldLines: 1, newStart: 10, newLines: 2 });
  });

  it("handles added and deleted files", () => {
    const files = parseDiff(
      d(
        "diff --git a/new.ts b/new.ts",
        "new file mode 100644",
        "index 000..111",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1,2 @@",
        "+a",
        "+b",
        "diff --git a/old.ts b/old.ts",
        "deleted file mode 100644",
        "index 111..000",
        "--- a/old.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
      ),
    );
    expect(files.map((f) => [f.file, f.status, f.oldFile])).toEqual([
      ["new.ts", "added", undefined],
      ["old.ts", "deleted", undefined],
    ]);
    expect(files[1]!.hunks[0]!.lines).toEqual(["-gone"]);
  });

  it("handles renames with and without content changes", () => {
    const files = parseDiff(
      d(
        "diff --git a/a b/b",
        "similarity index 100%",
        "rename from a",
        "rename to b",
        "diff --git a/dir/x.ts b/dir/y.ts",
        "similarity index 90%",
        "rename from dir/x.ts",
        "rename to dir/y.ts",
        "index 1..2 100644",
        "--- a/dir/x.ts",
        "+++ b/dir/y.ts",
        "@@ -1 +1 @@",
        "-x",
        "+y",
      ),
    );
    expect(files[0]).toMatchObject({ file: "b", oldFile: "a", status: "renamed", hunks: [] });
    expect(files[1]).toMatchObject({ file: "dir/y.ts", oldFile: "dir/x.ts", status: "renamed" });
    expect(files[1]!.hunks).toHaveLength(1);
  });

  it("handles binary files and mode changes", () => {
    const files = parseDiff(
      d(
        "diff --git a/img.png b/img.png",
        "index 1..2 100644",
        "Binary files a/img.png and b/img.png differ",
        "diff --git a/run.sh b/run.sh",
        "old mode 100644",
        "new mode 100755",
      ),
    );
    expect(files[0]).toMatchObject({ file: "img.png", binary: true, hunks: [] });
    expect(files[1]).toMatchObject({ file: "run.sh", modeChange: true, hunks: [] });
  });

  it("keeps 'no newline' markers and CR characters inside the hunk", () => {
    const [f] = parseDiff(
      d(
        "diff --git a/w.txt b/w.txt",
        "--- a/w.txt",
        "+++ b/w.txt",
        "@@ -1 +1 @@",
        "-a\r",
        "\\ No newline at end of file",
        "+b\r",
        "\\ No newline at end of file",
      ),
    );
    expect(f!.hunks[0]!.lines).toEqual(["-a\r", "\\ No newline at end of file", "+b\r", "\\ No newline at end of file"]);
  });

  it("doesn't mistake content that looks like headers for headers", () => {
    const [f] = parseDiff(
      d(
        "diff --git a/x.md b/x.md",
        "--- a/x.md",
        "+++ b/x.md",
        "@@ -1,2 +1,2 @@",
        "-@@ -1 +1 @@",
        "+diff --git a/z b/z",
        " --- a/q",
      ),
    );
    expect(f!.hunks).toHaveLength(1);
    expect(f!.hunks[0]!.lines).toEqual(["-@@ -1 +1 @@", "+diff --git a/z b/z", " --- a/q"]);
  });

  it("reads paths with spaces, ' b/' inside, and git quoting", () => {
    const files = parseDiff(
      d(
        "diff --git a/my file.txt b/my file.txt",
        "old mode 100644",
        "new mode 100755",
        "diff --git a/x b/y.txt b/x b/y.txt",
        "Binary files a/x b/y.txt and b/x b/y.txt differ",
        'diff --git "a/caf\\303\\251\\t.txt" "b/caf\\303\\251\\t.txt"',
        "old mode 100644",
        "new mode 100755",
      ),
    );
    expect(files.map((f) => f.file)).toEqual(["my file.txt", "x b/y.txt", "café\t.txt"]);
  });

  it("returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });
});

describe("unquotePath", () => {
  it("decodes octal UTF-8 and escapes", () => {
    expect(unquotePath('"a/\\346\\227\\245.txt"')).toBe("a/日.txt");
    expect(unquotePath('"a\\"b\\\\c"')).toBe('a"b\\c');
    expect(unquotePath("plain")).toBe("plain");
  });
});
