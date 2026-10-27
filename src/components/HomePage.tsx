import { useEffect, useState } from "react";
import type { RunSummary } from "../../shared/schema";
import { loadRuns } from "../api";

const SOURCE: Record<string, string> = {
  pr: "branch",
  working: "branch + working tree",
  staged: "staged",
  uncommitted: "uncommitted",
  stack: "PRs",
};

// Every run being served, from any repo. Runs come and go as `serve` starts
// and stops in other terminals, so this keeps polling.
export function Home() {
  const [runs, setRuns] = useState<RunSummary[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    const load = () =>
      loadRuns().then(
        (r) => alive && (setRuns(r), setError(undefined)),
        (e: Error) => alive && setError(e.message),
      );
    void load();
    const timer = window.setInterval(load, 2000);
    window.addEventListener("focus", load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
    };
  }, []);

  const repos = new Set(runs?.map((r) => r.repo));
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="spark">✦</span> spark-joy
        </div>
        <div className="run">
          {runs ? `${runs.length} run${runs.length === 1 ? "" : "s"} being served${repos.size > 1 ? ` across ${repos.size} repos` : ""}` : ""}
        </div>
      </header>
      {error && !runs ? (
        <div className="empty">Can't load runs: {error}</div>
      ) : !runs ? (
        <div className="empty">Loading…</div>
      ) : !runs.length ? (
        <div className="empty">
          Nothing being served. Run <code>spark-joy serve</code> in a repo, or ask your agent to.
        </div>
      ) : (
        <ul className="runs">
          {runs.map((r) => (
            <li key={r.id}>
              <a href={`r/${r.id}/`}>
                <span className="run-title">{r.title}</span>
                <span className="run-where">
                  <code>{r.repo}</code> · {r.run}
                  {r.source && ` · ${SOURCE[r.source] ?? r.source}`}
                </span>
                <span className="progress" title={`${r.reviewed}/${r.hunks} hunks reviewed`}>
                  <span className="bar">
                    <span style={{ width: `${r.hunks ? (100 * r.reviewed) / r.hunks : 0}%` }} />
                  </span>
                  <span>
                    {r.reviewed}/{r.hunks}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
