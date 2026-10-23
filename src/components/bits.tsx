import { Fragment } from "react";
import { prChunk, prRef, prsOf, type ChunkStatus } from "../../shared/derive";
import type { Chunk, Hunk, Meta, Plan } from "../../shared/schema";
import type { Issue } from "../../shared/validate";

// Stack mode: a link to the PR or MR a chunk is, e.g. "#12".
export function PrLink({ meta, chunk }: { meta: Meta; chunk: Chunk }) {
  if (!chunk.pr) return null;
  return (
    <a className="pr-link" href={chunk.pr.url} target="_blank" rel="noreferrer" title={`Open ${chunk.pr.url}`}>
      {prRef(meta, chunk.pr.number)}
    </a>
  );
}

// Stack mode: links to each PR a chunk takes hunks from, for chunks that span PRs.
export function PrLinks({ meta, plan, hunks }: { meta: Meta; plan: Plan; hunks: readonly Hunk[] }) {
  return (
    <>
      {prsOf(hunks).map((n) => {
        const pr = prChunk(plan, n);
        return pr ? <PrLink key={n} meta={meta} chunk={pr} /> : null;
      })}
    </>
  );
}

// Stack mode: heads the chunks a PR was broken into, in lists of chunks.
export function PrHeading({ meta, chunk }: { meta: Meta; chunk: Chunk }) {
  return (
    <li className="pr-group">
      <PrLink meta={meta} chunk={chunk} /> <span className="title">{chunk.title}</span>
    </li>
  );
}

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
// `compact` drops the word "risk" for lists and puts the reason in a tooltip.
export function Risk({ risk, reason, compact }: { risk: "low" | "med" | "high"; reason?: string; compact?: boolean }) {
  if (risk === "low") return null;
  const word = risk === "med" ? "Med" : "High";
  return (
    <span className={`risk risk-${risk}`} title={reason ? `${word} risk: ${reason}` : `${word} risk`}>
      {compact ? word : `${word} risk`}
    </span>
  );
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

// Plan text is plain, but agents tend to write `identifiers` in backticks.
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
