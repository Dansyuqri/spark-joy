import { branchName, defaultPrefix, hunkStatus, strategyLabel, strategyView } from "../../shared/derive";
import type { Plan, ReviewState } from "../../shared/schema";
import type { RunData } from "../api";
import { routeHref, type Update } from "../App";
import { Issues, Kind, Risk, StatusIcon, Text, plural } from "./bits";

interface Props {
  data: RunData;
  plan: Plan;
  state: ReviewState;
  update: Update;
}

export function PlanPage({ data, plan, state, update }: Props) {
  const reviewed = new Set(state.reviewed);
  const split = plan.mode === "split";
  const prefix = defaultPrefix(data.meta.branch);

  return (
    <main className="page plan-page">
      {plan.overview && (
        <p className="overview">
          <Text>{plan.overview}</Text>
        </p>
      )}
      <Issues issues={data.issues} />
      {data.rubric && (
        <details className="rubric">
          <summary>Risk rubric</summary>
          {data.rubric.high.length > 0 && (
            <p>
              <span className="risk risk-high">High</span> {data.rubric.high.join(", ")}
            </p>
          )}
          {data.rubric.med.length > 0 && (
            <p>
              <span className="risk risk-med">Med</span> {data.rubric.med.join(", ")}
            </p>
          )}
        </details>
      )}
      <div className="strategies">
        {plan.strategies.map((s) => {
          const view = strategyView(plan, data.hunks, s.id)!;
          const largest = Math.max(0, ...view.chunks.map((c) => c.size));
          const isOn = state.strategy === s.id;
          return (
            <section key={s.id} className={`strategy ${isOn ? "on" : ""}`}>
              <h3>{strategyLabel(s)}</h3>
              <p className="stats">
                {plural(s.chunks.length, split ? "PR" : "chunk")} · max {largest} lines
              </p>
              <ol className="chunk-list">
                {view.chunks.map((c) => (
                  <li key={c.chunk.id}>
                    <StatusIcon status={hunkStatus(c.hunks, reviewed)} />
                    <span className="n">{c.index + 1}</span>
                    <span className="title">
                      {c.chunk.title}
                      {split && <code className="branch">{branchName(prefix, c.index + 1, c.chunk)}</code>}
                    </span>
                    <Risk risk={c.chunk.risk} reason={c.chunk.riskReason} compact />
                    <Kind kind={c.chunk.kind} />
                    <span className="size">{c.size}</span>
                  </li>
                ))}
              </ol>
              <button
                className={isOn ? "primary" : ""}
                onClick={() => {
                  update((st) => ({ ...st, strategy: s.id }));
                  location.hash = routeHref({ page: "review", chunk: 0 });
                }}
              >
                {isOn ? "Continue" : "Start"}
              </button>
              {split && (
                <p className="hint">
                  Create the branches: <code>spark-joy split --apply</code>
                </p>
              )}
            </section>
          );
        })}
      </div>

      {plan.features.length > 0 && (
        <>
          <h2>Features</h2>
          <ul className="features compact">
          {plan.features.map((f) => (
            <li key={f.title} title={f.description}>
              {f.title}
            </li>
          ))}
          </ul>
        </>
      )}
    </main>
  );
}
