import type { Issue } from "../shared/validate";
import type { AutoLink, Hunk, Meta, Plan, PrKey, ReviewState, Rubric } from "../shared/schema";

export interface RunData {
  meta: Meta;
  hunks: Hunk[];
  plan?: Plan;
  issues: Issue[];
  hasPlan: boolean;
  links: AutoLink[];
  state: ReviewState;
  rubric?: Rubric;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data as T;
}

export const loadRun = () => call<RunData>("GET", "/api/run");
export const saveState = (state: ReviewState) => call<ReviewState>("PUT", "/api/state", state);
export const exportReview = () => call<{ path: string; markdown: string }>("POST", "/api/export");
export const loadFile = (path: string, pr?: PrKey) =>
  call<{ lines: string[] }>("GET", `/api/file?path=${encodeURIComponent(path)}${pr === undefined ? "" : `&pr=${encodeURIComponent(pr)}`}`);
