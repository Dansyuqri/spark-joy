import { Fragment } from "react";
import { branchName, defaultPrefix, groupedByPr, hunkStatus, prChunk, strategyLabel, strategyView, unitName } from "../../shared/derive";
import type { Plan, ReviewState } from "../../shared/schema";
import type { RunData } from "../api";
import { routeHref, type Update } from "../App";
import { Issues, Kind, PrHeading, PrLink, Risk, StatusIcon, Text, plural } from "./bits";

interface Props {
  data: RunData;
  plan: Plan;
  state: ReviewState;
  update: Update;
}

export function PlanPage({ data, plan, state, update }: Props) {
  const reviewed = new Set(state.reviewed);
  const split = plan.mode !== "review";
  const unit = unitName(plan, data.meta);
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
          const grouped = groupedByPr(plan, s);
          return (
            <section key={s.id} className={`strategy ${isOn ? "on" : ""}`}>
              <h3>{strategyLabel(s)}</h3>
              <p className="stats">
                {grouped ? `${plural(s.chunks.length, "chunk")} in ${plural(plan.strategies[0]!.chunks.length, unit)}` : plural(s.chunks.length, unit)}
                {` · max ${largest} lines`}
              </p>
              <ol className="chunk-list">
                {view.chunks.map((c, i) => {
                  const pr = grouped && c.chunk.pr?.number !== view.chunks[i - 1]?.chunk.pr?.number ? prChunk(plan, c.chunk.pr?.number) : undefined;
                  return (
                    <Fragment key={c.chunk.id}>
                      {pr && <PrHeading meta={data.meta} chunk={pr} />}
                      <li>
                        <StatusIcon status={hunkStatus(c.hunks, reviewed)} />
                        <span className="n">{c.index + 1}</span>
                        <span className="title">
                          {c.chunk.title}
                          {!grouped && <PrLink meta={data.meta} chunk={c.chunk} />}
                          {split && !grouped && <code className="branch">{branchName(prefix, c.index + 1, c.chunk)}</code>}
                        </span>
                        <Risk risk={c.chunk.risk} reason={c.chunk.riskReason} compact />
                        <Kind kind={c.chunk.kind} />
                        <span className="size">{c.size}</span>
                      </li>
                    </Fragment>
                  );
                })}
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
              {plan.mode === "stack" && plan.strategies.length === 1 && (
                <p className="hint">
                  To break the {unit}s into chunks, ask your agent to <q>break up the {data.meta.run} run</q>. The new orders show up
                  here when you come back to this tab.
                </p>
              )}
              {plan.mode === "split" && (
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
