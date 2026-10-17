import type { ChunkStatus } from "../../shared/derive";
import type { Issue } from "../../shared/validate";

export function StatusIcon({ status }: { status: ChunkStatus }) {
  const label = { done: "Reviewed", partial: "Partly reviewed, or changed since review", todo: "Not reviewed" }[status];
  return (
    <span className={`status ${status}`} title={label} aria-label={label}>
      {status === "done" ? "✓" : status === "partial" ? "◐" : "○"}
    </span>
  );
}

export function Risk({ risk }: { risk: "low" | "med" | "high" }) {
  return <span className={`badge risk-${risk}`}>{risk === "med" ? "medium" : risk} risk</span>;
}

export function Kind({ kind }: { kind: string }) {
  return <span className={`badge kind-${kind}`}>{kind}</span>;
}

export function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.level === "error");
  return (
    <details className={`issues ${errors.length ? "has-errors" : ""}`} open={errors.length > 0}>
      <summary>
        Plan check: {errors.length} error{errors.length === 1 ? "" : "s"}, {issues.length - errors.length} warning
        {issues.length - errors.length === 1 ? "" : "s"}
      </summary>
      <ul>
        {issues.map((i, n) => (
          <li key={n} className={i.level}>
            <strong>{i.where}</strong>: {i.message}
          </li>
        ))}
      </ul>
    </details>
  );
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
