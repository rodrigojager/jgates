import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import { t } from "../i18n";
import { Icon } from "./icons";

/** Loads data once per key; exposes the error and a reload function. */
export function useAsync<T>(load: () => Promise<T>, key: string): { data: T | null; error: unknown; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error) => live && setState({ data: null, error, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  return { ...state, reload: () => setTick((n) => n + 1) };
}

export function errorText(error: unknown): { message: string; fix: string | null } {
  if (error instanceof ApiError) {
    if (error.status === 401) return { message: t("error_session"), fix: null };
    return { message: error.message, fix: error.fix };
  }
  // A request that got no answer (fetch rejects with a TypeError): the local server is not reachable.
  return { message: t("error_network"), fix: t("error_network_fix") };
}

/** Event the application shell listens to (app/shell-context.tsx) to check at once whether the server still answers. */
const PROBE_EVENT = "jgates:probe";

export function ErrorNotice({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { message, fix } = errorText(error);
  const unreachable = !(error instanceof ApiError);
  useEffect(() => {
    if (unreachable) window.dispatchEvent(new Event(PROBE_EVENT));
  }, [unreachable]);
  return (
    <div className="notice error" role="alert">
      <Icon name="alert" />
      <div className="grow stack">
        <strong>{t("error_title")}</strong>
        <p>{message}</p>
        {fix ? <p className="small">{fix}</p> : null}
        {onRetry ? (
          <div>
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" />
              {t("retry")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function Loading() {
  return (
    <p className="spinner-text" role="status">
      {t("loading")}
    </p>
  );
}

export function Pill({ tone, children }: { tone?: "green" | "gold" | "red" | "blue"; children: ReactNode }) {
  return <span className={`pill${tone ? ` ${tone}` : ""}`}>{children}</span>;
}

/** Modal built on the native <dialog>: focus trap, Escape and focus return come from the platform. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  return (
    <dialog ref={ref} aria-labelledby="dialog-title" className={wide ? "wide" : ""} onClose={onClose} onCancel={onClose}>
      <div className="dialog-body">
        <div className="between">
          <h2 id="dialog-title">{title}</h2>
          <button type="button" className="btn" onClick={onClose}>
            {t("close")}
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
