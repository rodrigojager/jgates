import { useEffect, useState } from "react";
import { ApiError, api } from "../../../api";
import { ErrorNotice, Pill, useAsync } from "../../../components/common";
import { DiffView } from "../../../components/DiffView";
import { Icon } from "../../../components/icons";
import { eb } from "./messages";

// Review of the plan: unsaved edits of documents the plan uses. A run reads the saved files, so for each document the
// person either saves the draft (the plan is built again and names the new hash) or uses the saved version (the draft
// stays as a draft and the plan keeps the hash of the file on disk). Nothing here executes the draft.

interface PendingDraft {
  ref: { instance: string; binding: string; entry: string | null };
  relPath: string | null;
  baseRevision: string | null;
  currentRevision: string | null;
  stale: boolean;
  orphan: boolean;
  updatedAt: string;
  diff: string;
  validation: { status: string; errors?: Array<{ message: string; line: number | null; column: number | null }> } | null;
  usedByPlan: boolean;
  planSha256: string | null;
}

// The choice "use the saved version" belongs to one version of the draft (its updatedAt is part of the key), so it
// survives a reload of the page and does not carry over to a draft typed later. Storage can be unavailable (private
// window, blocked site data): the page then simply asks again.
const CHOICE_STORAGE_KEY = "jgates.draft-choice.v1";
const MAX_CHOICES = 200;

function loadChoices(): Set<string> {
  try {
    const raw = window.localStorage.getItem(CHOICE_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

function storeChoices(choices: Set<string>): void {
  try {
    window.localStorage.setItem(CHOICE_STORAGE_KEY, JSON.stringify([...choices].slice(-MAX_CHOICES)));
  } catch {
    // not remembered
  }
}

const keyOf = (d: PendingDraft): string => `${d.ref.instance}/${d.ref.binding}/${d.ref.entry ?? ""}/${d.updatedAt}`;
const short = (hash: string | null): string => (hash ? hash.replace(/^sha256:/, "").slice(0, 12) : "-");

export interface PendingDraftsProps {
  /** Hash of the plan under review (null while none is built). */
  planHash: string | null;
  /** Called when the number of documents with no choice yet changes. */
  onUnresolved(count: number): void;
  /** A draft was saved into its file: build the plan again. */
  onSaved(): void;
}

export function PendingDrafts({ planHash, onUnresolved, onSaved }: PendingDraftsProps) {
  const [tick, setTick] = useState(0);
  const found = useAsync(() => (planHash ? api<{ drafts: PendingDraft[] }>("GET", `/api/drafts?plan=${encodeURIComponent(planHash)}`) : Promise.resolve({ drafts: [] as PendingDraft[] })), `drafts:${planHash}:${tick}`);
  // Choice "use the saved version", remembered per draft version so a rebuilt plan does not ask again.
  const [usingSaved, setUsingSaved] = useState<Set<string>>(loadChoices);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ key: string; error: unknown } | null>(null);

  const used = (found.data?.drafts ?? []).filter((d) => d.usedByPlan && !d.orphan);
  const others = (found.data?.drafts ?? []).filter((d) => !d.usedByPlan && !d.orphan);
  const unresolved = used.filter((d) => !usingSaved.has(keyOf(d))).length;
  useEffect(() => onUnresolved(found.loading ? (planHash ? 1 : 0) : unresolved), [found.loading, unresolved, planHash, onUnresolved]);

  async function save(d: PendingDraft, allowInvalid: boolean) {
    const key = keyOf(d);
    setBusy(key);
    setFailure(null);
    try {
      await api("POST", `/api/drafts/${encodeURIComponent(d.ref.instance)}/${encodeURIComponent(d.ref.binding)}/save`, {
        ...(d.ref.entry ? { entry: d.ref.entry } : {}),
        ...(allowInvalid ? { allowInvalid: true } : {}),
      });
      setTick((n) => n + 1);
      onSaved();
    } catch (e) {
      setFailure({ key, error: e });
    } finally {
      setBusy(null);
    }
  }

  if (found.error) return <ErrorNotice error={found.error} onRetry={found.reload} />;
  if (used.length === 0 && others.length === 0) return null;

  return (
    <section className="card flat stack" aria-labelledby={used.length > 0 ? "pending-drafts-title" : undefined} data-testid="pending-drafts">
      {used.length > 0 ? (
        <>
          <h2 id="pending-drafts-title">{eb("pending_title")}</h2>
          <p>{eb("pending_lead")}</p>
          <ul className="stack">
            {used.map((d) => {
              const key = keyOf(d);
              const invalid = d.validation?.status === "invalid";
              const first = d.validation?.errors?.[0];
              const chosen = usingSaved.has(key);
              const conflict = failure?.key === key && failure.error instanceof ApiError && failure.error.code === "REVISION_CONFLICT";
              return (
                <li key={key} className="stack tight" data-testid="pending-draft">
                  <div className="between wrap">
                    <strong>
                      <code>{d.relPath ?? d.ref.binding}</code>
                    </strong>
                    <span className="small muted">
                      {eb("pending_plan_hash")}: <code>{short(d.planSha256)}</code>
                    </span>
                  </div>
                  {d.stale ? <p className="small">{eb("pending_stale")}</p> : null}
                  {invalid ? (
                    <div className="notice error" role="status">
                      <Icon name="alert" />
                      <p>{eb("pending_invalid", { message: `${first?.message ?? ""}${first?.line ? ` (linha ${first.line})` : ""}` })}</p>
                    </div>
                  ) : null}
                  <details>
                    <summary>{eb("pending_view_diff")}</summary>
                    <DiffView diff={d.diff} />
                  </details>
                  <div className="row wrap">
                    <button type="button" className="btn" disabled={busy !== null} onClick={() => void save(d, invalid)}>
                      <Icon name="check" />
                      {invalid ? eb("pending_save_invalid") : eb("pending_save")}
                    </button>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy !== null || chosen}
                      onClick={() =>
                        setUsingSaved((s) => {
                          const next = new Set(s).add(key);
                          storeChoices(next);
                          return next;
                        })
                      }
                    >
                      {eb("pending_use_saved")}
                    </button>
                    {chosen ? <Pill tone="green">{eb("pending_saved_choice")}</Pill> : null}
                  </div>
                  {conflict ? (
                    <div className="notice warn" role="alert">
                      <Icon name="alert" />
                      <p>{eb("pending_conflict")}</p>
                    </div>
                  ) : failure?.key === key ? (
                    <ErrorNotice error={failure.error} />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {unresolved > 0 ? <p className="small" role="status">{eb("pending_unresolved")}</p> : null}
        </>
      ) : null}
      {others.length > 0 ? <p className="small muted">{eb("pending_other")}</p> : null}
    </section>
  );
}
