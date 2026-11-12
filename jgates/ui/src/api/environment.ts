// Client of the environment routes: the state of every section, the preparation jobs with their progress events, and the
// states catalogue. The server reads the machine fresh at every call, so a Docker installed or started while the page
// was open shows on the next check; `useRecheckOnFocus` makes that check happen when the person comes back to the tab.
import { useEffect, useRef } from "react";
import { api } from "../api";

export interface ReasonAction {
  kind: "command" | "link" | "route" | "none";
  label: string;
  command?: string;
  url?: string;
  route?: string;
}

export interface EnvironmentReason {
  code: string;
  message: string;
  action: ReasonAction;
  details?: string;
}

export interface EnvironmentSection {
  state: string;
  reasons: EnvironmentReason[];
  [key: string]: unknown;
}

export interface EnvironmentState {
  ready: boolean;
  mode: "container" | "in-image";
  checkedAt: string;
  reasons: EnvironmentReason[];
  warnings: EnvironmentReason[];
  sections: Record<"engine" | "image" | "data" | "dependencies" | "services" | "extension" | "codeql", EnvironmentSection>;
}

export type JobKind = "pull" | "data" | "dependencies";

export interface JobEvent {
  seq: number;
  type: string;
  [key: string]: unknown;
}

export interface JobPage {
  job: { id: string; kind: JobKind; state: "running" | "done" | "failed" };
  events: JobEvent[];
  next: number;
}

/**
 * The environment state. The server answers from its cached engine facts (a few seconds old at most, refreshed in the
 * background); `fresh` is an explicit "check again", which asks the engine everything anew.
 */
export const fetchEnvironmentState = (locale?: string, signal?: AbortSignal, fresh = false): Promise<EnvironmentState> => {
  const query = new URLSearchParams();
  if (locale) query.set("locale", locale);
  if (fresh) query.set("fresh", "1");
  const text = query.toString();
  return api<EnvironmentState>("GET", `/api/environment/state${text ? `?${text}` : ""}`, undefined, signal);
};

export const startEnvironmentJob = (kind: JobKind, locale?: string): Promise<{ job: JobPage["job"]; reused: boolean }> =>
  api("POST", "/api/environment/jobs", { kind, ...(locale ? { locale } : {}) });

export const fetchJobPage = (id: string, after: number, waitMs = 0, signal?: AbortSignal): Promise<JobPage> =>
  api<JobPage>("GET", `/api/environment/jobs/${encodeURIComponent(id)}?after=${after}${waitMs > 0 ? `&wait=${waitMs}` : ""}`, undefined, signal);

/** Follows a job to its end, calling `onEvents` with each new batch (long polling by cursor). */
export async function followJob(id: string, onEvents: (events: JobEvent[], job: JobPage["job"]) => void, signal?: AbortSignal): Promise<JobPage["job"]> {
  let after = 0;
  for (;;) {
    const page = await fetchJobPage(id, after, 20_000, signal);
    after = page.next;
    if (page.events.length > 0) onEvents(page.events, page.job);
    if (page.job.state !== "running") return page.job;
  }
}

export interface Catalogue {
  locales: string[];
  reasons: Array<{ code: string; text: Record<string, string>; action: Omit<ReasonAction, "label"> & { label: Record<string, string> } }>;
  planActions: Array<{ kind: string; label: Record<string, string> }>;
  toolchainActions: Array<{ id: string; label: Record<string, string> }>;
}

export const fetchCatalogue = (): Promise<Catalogue> => api<Catalogue>("GET", "/api/reasons");

/**
 * Calls `check` when the tab becomes visible again or the window gets focus (at most once per second), so the screen
 * sees a Docker that was installed or started meanwhile without a restart.
 */
export function useRecheckOnFocus(check: () => void): void {
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => {
    let last = 0;
    const fire = (): void => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      latest.current();
    };
    window.addEventListener("focus", fire);
    document.addEventListener("visibilitychange", fire);
    return () => {
      window.removeEventListener("focus", fire);
      document.removeEventListener("visibilitychange", fire);
    };
  }, []);
}
