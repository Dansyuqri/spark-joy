import { Fragment } from "react";
import type { ChunkStatus } from "../../shared/derive";
import type { Issue } from "../../shared/validate";

export function StatusIcon({ status }: { status: ChunkStatus }) {
  const label = { done: "Reviewed", partial: "Partly reviewed, or changed since review", todo: "Not reviewed" }[status];
  return (
    <span className={`status ${status}`} title={label} aria-label={label} role="img">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {status === "done" ? (
          <>
            <circle cx="8" cy="8" r="7" fill="currentColor" />
            <path d="M4.8 8.3l2.1 2.1 4.3-4.6" fill="none" stroke="var(--bg)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </>
        ) : status === "partial" ? (
          <>
            <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" />
          </>
        ) : (
          <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" />
        )}
      </svg>
    </span>
  );
}

// Only medium and high risk are shown; low is the default and needs no ink.
export function Risk({ risk }: { risk: "low" | "med" | "high" }) {
  if (risk === "low") return null;
  const label = risk === "med" ? "Medium risk" : "High risk";
  return <span className={`risk risk-${risk}`} title={label} aria-label={label} role="img" />;
}

// "core" is the default kind, so only tests and mechanical chunks get a tag.
export function Kind({ kind }: { kind: string }) {
  return kind === "core" ? null : <span className={`badge kind-${kind}`}>{kind}</span>;
}

export function Issues({ issues }: { issues: Issue[] }) {
  if (!issues.length) return null;
  const errors = issues.filter((i) => i.level === "error");
  return (
    <details className={`issues ${errors.length ? "has-errors" : ""}`} open={errors.length > 0}>
      <summary>
        {plural(errors.length, "error")}, {plural(issues.length - errors.length, "warning")}
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

// Plan text is plain, but Claude tends to write `identifiers` in backticks.
export function Text({ children }: { children: string }) {
  return (
    <>
      {children.split(/(`[^`]+`)/).map((part, i) =>
        part.length > 2 && part.startsWith("`") && part.endsWith("`") ? (
          <code key={i}>{part.slice(1, -1)}</code>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
