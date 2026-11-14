import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError } from "../api";
import { t } from "../i18n";
import { Icon } from "./icons";

/** Loads data once per key; exposes the error and a reload function. */
export function useAsync<T>(load: () => Promise<T>, key: string): { data: T | null; error: unknown; loading: boolean; reloading: boolean; reload: () => void; prime: (data: T, forKey?: string) => void } {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const primed = useRef<string | null>(null);
  const generation = useRef(0);
  useEffect(() => {
    // The answer of a write already carries this key's data (see prime): nothing to ask.
    if (primed.current === key) {
      primed.current = null;
      return;
    }
    let live = true;
    const mine = ++generation.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    load().then(
      (data) => live && mine === generation.current && setState({ data, error: null, loading: false }),
      (error) => live && mine === generation.current && setState({ data: null, error, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);
  /** Puts data that came from elsewhere (the answer of a write) in place of a request; `forKey` is the key it will have next. */
  const prime = (data: T, forKey?: string) => {
    generation.current += 1;
    primed.current = forKey !== undefined && forKey !== key ? forKey : null;
    setState({ data, error: null, loading: false });
  };
  // Reloading: asking again while the previous data stays on screen (the screen shows it with an updating indicator).
  return { ...state, reloading: state.loading && state.data !== null, reload: () => setTick((n) => n + 1), prime };
}

/** The one indicator of a screen that keeps its content while it asks again; the screen puts aria-busy on its content too. */
export function Updating({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <p className="spinner-text" role="status" aria-busy="true" data-testid="updating">
      {t("updating")}
    </p>
  );
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

/** The turning ring of work in progress, beside a button's label or a status line; still under reduced motion. */
export function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
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

/**
 * Modal built on the native <dialog>: the focus trap and Escape come from the platform. The element that had focus when
 * the dialog opened gets it back when the dialog closes: a dialog that React unmounts leaves nothing for the platform
 * to restore, so the opener is remembered here.
 */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  // A dialog that brings its own Cancelar (or Fechar) has one way to cancel: the header's button steps aside.
  const [ownCancel, setOwnCancel] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (dialog && !dialog.open) dialog.showModal();
    let observer: MutationObserver | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (dialog) {
      const content = () => dialog.querySelector<HTMLElement>(".dialog-content");
      const names = new Set([t("cancel"), t("close")].map((s) => s.trim().toLowerCase()));
      // The first field; a dialog with none (a confirmation) puts the focus on its title, never on a button that acts.
      const FIELD = 'input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled), [contenteditable=true]';
      const visible = (el: HTMLElement) => el.offsetParent !== null || getComputedStyle(el).position === "fixed";
      let touched = false;
      const sync = () => {
        const root = content();
        if (!root) return;
        setOwnCancel([...root.querySelectorAll<HTMLElement>("button")].some((b) => names.has((b.textContent ?? "").trim().toLowerCase())));
        if (touched) return;
        const field = [...root.querySelectorAll<HTMLElement>(FIELD)].find(visible);
        const target = field ?? dialog.querySelector<HTMLElement>("#dialog-title");
        const active = document.activeElement;
        // Only the places the platform leaves it (the dialog itself, the header's button, nothing) are taken over.
        const idle = !active || active === document.body || active === dialog || active === dialog.querySelector(".dialog-head button") || active === dialog.querySelector("#dialog-title");
        if (target && idle) target.focus();
      };
      const touch = () => {
        touched = true;
      };
      dialog.addEventListener("keydown", touch);
      dialog.addEventListener("pointerdown", touch);
      sync();
      // Content that arrives after the first paint (a form that loads its data) gets the focus too, for a moment.
      observer = new MutationObserver(sync);
      observer.observe(dialog, { childList: true, subtree: true });
      timer = setTimeout(() => observer?.disconnect(), 2500);
    }
    return () => {
      observer?.disconnect();
      if (timer) clearTimeout(timer);
      if (dialog?.open) dialog.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog ref={ref} aria-labelledby="dialog-title" className={wide ? "wide" : ""} onClose={onClose} onCancel={onClose}>
      <div className="dialog-body">
        <div className="between dialog-head">
          <h2 id="dialog-title" tabIndex={-1}>
            {title}
          </h2>
          {ownCancel ? null : (
            <button type="button" className="btn" onClick={onClose}>
              {t("close")}
            </button>
          )}
        </div>
        <div className="dialog-content">{children}</div>
      </div>
    </dialog>
  );
}
