import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { headLabel, progress, strategyView } from "../shared/derive";
import type { ReviewState } from "../shared/schema";
import { loadRun, saveState, type RunData } from "./api";
import { MapPage } from "./components/MapPage";
import { PlanPage } from "./components/PlanPage";
import { ReviewPage } from "./components/ReviewPage";
import { SummaryPage } from "./components/SummaryPage";
import { Issues } from "./components/bits";

export type Route =
  | { page: "plan" }
  | { page: "map"; chunk?: number }
  | { page: "review"; chunk: number | "skim"; file?: string }
  | { page: "summary" };

const chunkArg = (arg: string | undefined) => Math.max(0, Number(arg ?? 1) - 1) || 0;

function parseRoute(hash: string): Route | undefined {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [page, arg] = path.split("/");
  if (page === "plan") return { page: "plan" };
  if (page === "summary") return { page: "summary" };
  if (page === "map") return { page: "map", chunk: arg ? chunkArg(arg) : undefined };
  if (page === "review")
    return {
      page: "review",
      chunk: arg === "skim" ? "skim" : chunkArg(arg),
      file: new URLSearchParams(query).get("file") ?? undefined,
    };
  return undefined;
}

export const routeHref = (r: Route) =>
  r.page === "review" ? `#/review/${r.chunk === "skim" ? "skim" : r.chunk + 1}` : `#/${r.page}`;

export type Update = (fn: (s: ReviewState) => ReviewState) => void;

export function App() {
  const [data, setData] = useState<RunData>();
  const [loadError, setLoadError] = useState<string>();
  const [state, setState] = useState<ReviewState>();
  const [saving, setSaving] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [route, setRoute] = useState<Route | undefined>(() => parseRoute(location.hash));
  const saveTimer = useRef<number>();
  const pending = useRef<ReviewState>();
  const inflight = useRef<Promise<unknown>>(Promise.resolve());

  const refresh = useCallback(async () => {
    try {
      // Let in-flight saves land first, so we don't read back older state.
      await inflight.current;
      const d = await loadRun();
      setData(d);
      // Local edits that haven't been saved yet win over what's on disk.
      setState((s) => (pending.current ? s : d.state));
      setLoadError(undefined);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Pick up a plan Claude rewrote while the app was open.
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    const onHash = () => setRoute(parseRoute(location.hash));
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("hashchange", onHash);
    };
  }, [refresh]);

  // Save the latest state; resolves once everything typed so far is on disk.
  const flush = useCallback(async () => {
    window.clearTimeout(saveTimer.current);
    const s = pending.current;
    if (!s) return inflight.current;
    pending.current = undefined;
    setSaving("saving");
    const save = inflight.current.then(() => saveState(s));
    inflight.current = save.catch(() => undefined);
    try {
      await save;
      setSaving(pending.current ? "saving" : "saved");
    } catch {
      setSaving("error");
    }
  }, []);

  const update: Update = useCallback(
    (fn) => {
      setState((prev) => {
        if (!prev) return prev;
        const next = fn(prev);
        pending.current = next;
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => void flush(), 300);
        return next;
      });
    },
    [flush],
  );

  useEffect(() => {
    const beforeUnload = () => void flush();
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [flush]);

  const view = useMemo(
    () => (data?.plan && state ? strategyView(data.plan, data.hunks, state.strategy) : undefined),
    [data, state],
  );

  if (loadError && !data) return <div className="empty">Can't load run: {loadError}</div>;
  if (!data || !state) return <div className="empty">Loading…</div>;

  const { meta } = data;
  const reviewed = new Set(state.reviewed);
  const prog = view ? progress(view, reviewed) : undefined;
  const current: Route = route ?? (state.strategy ? { page: "review", chunk: 0 } : { page: "plan" });

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="spark">✦</span> spark-joy
        </div>
        <div
          className="run"
          title={`${meta.base} → ${headLabel(meta)} · +${meta.stats.added} −${meta.stats.removed} · ${meta.stats.files} files`}
        >
          {data.plan?.title ?? meta.branch}
        </div>
        <nav className="tabs">
          <a className={current.page === "plan" ? "on" : ""} href="#/plan">
            Plan
          </a>
          <a className={current.page === "map" ? "on" : ""} href="#/map">
            Map
          </a>
          <a className={current.page === "review" ? "on" : ""} href={routeHref({ page: "review", chunk: 0 })}>
            Review
          </a>
          <a className={current.page === "summary" ? "on" : ""} href="#/summary">
            Summary
          </a>
        </nav>
        {prog && (
          <div className="progress" title={`${prog.linesDone}/${prog.linesTotal} changed lines reviewed`}>
            <div className="bar">
              <div style={{ width: `${prog.total ? (100 * prog.done) / prog.total : 0}%` }} />
            </div>
            <span>
              {prog.done}/{prog.total}
            </span>
          </div>
        )}
        <span className={`saving ${saving}`}>
          {saving === "saving" ? "Saving…" : saving === "saved" ? "Saved" : saving === "error" ? "Save failed" : ""}
        </span>
      </header>

      {!data.hasPlan ? (
        <div className="empty">
          No plan yet. Run <code>/spark-joy</code> in Claude Code.
        </div>
      ) : !data.plan || !view ? (
        <div className="empty">
          <Issues issues={data.issues} />
        </div>
      ) : current.page === "plan" ? (
        <PlanPage data={data} plan={data.plan} state={state} update={update} />
      ) : current.page === "map" ? (
        <MapPage data={data} plan={data.plan} view={view} state={state} at={current.chunk} />
      ) : current.page === "summary" ? (
        <SummaryPage data={data} plan={data.plan} view={view} state={state} flush={flush} />
      ) : (
        <ReviewPage
          data={data}
          plan={data.plan}
          view={view}
          state={state}
          update={update}
          at={current.chunk}
          file={current.file}
        />
      )}
    </div>
  );
}
