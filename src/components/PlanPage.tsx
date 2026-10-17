import { hunkStatus, strategyView } from "../../shared/derive";
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
  const chosen = state.strategy ?? undefined;

  return (
    <main className="page plan-page">
      {plan.overview && (
        <p className="overview">
          <Text>{plan.overview}</Text>
        </p>
      )}
      <Issues issues={data.issues} />
      <h2>Choose a review order</h2>
      <p className="muted">
        Both orders cover the same changes; your progress carries over if you switch later.
      </p>
      <div className="strategies">
        {plan.strategies.map((s) => {
          const view = strategyView(plan, data.hunks, s.id)!;
          const sizes = view.chunks.map((c) => c.size);
          const largest = Math.max(0, ...sizes);
          const high = s.chunks.filter((c) => c.risk === "high").length;
          const isOn = chosen === s.id;
          return (
            <section key={s.id} className={`strategy ${isOn ? "on" : ""}`}>
              <header>
                <h3>{s.label}</h3>
                {s.description && <p className="muted">{s.description}</p>}
                <p className="stats">
                  {plural(s.chunks.length, "chunk")} · largest {largest} lines
                  {high ? ` · ${high} high risk` : ""} · {plural(view.skim.length, "skim hunk")}
                </p>
              </header>
              <ol className="chunk-list">
                {view.chunks.map((c) => (
                  <li key={c.chunk.id}>
                    <StatusIcon status={hunkStatus(c.hunks, reviewed)} />
                    <span className="title">{c.chunk.title}</span>
                    <span className="meta">
                      <Kind kind={c.chunk.kind} /> {c.chunk.risk !== "low" && <Risk risk={c.chunk.risk} />}{" "}
                      <span className="size">{c.size}</span>
                    </span>
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
                {isOn ? "Continue reviewing" : "Review in this order"}
              </button>
            </section>
          );
        })}
      </div>

      {plan.features.length > 0 && (
        <>
          <h2>What this PR does</h2>
          <ul className="features">
            {plan.features.map((f) => (
              <li key={f.title}>
                <strong>{f.title}</strong>
                <span className="muted">
                  {" "}
                  <Text>{f.description}</Text>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
