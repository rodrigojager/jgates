import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { t } from "../i18n";
import { Icon } from "./icons";

export type ToastTone = "ok" | "warn" | "error" | "info";
interface ToastItem {
  id: number;
  tone: ToastTone;
  message: string;
}

type Notify = (message: string, tone?: ToastTone) => void;
const ToastContext = createContext<Notify>(() => undefined);

/** `const toast = useToast(); toast("Salvo", "ok")`: a short message announced politely, gone after a few seconds. */
export function useToast(): Notify {
  return useContext(ToastContext);
}

const LIFETIME_MS = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setItems((all) => all.filter((x) => x.id !== id)), []);
  const notify = useCallback<Notify>(
    (message, tone = "info") => {
      const id = next.current++;
      setItems((all) => [...all.slice(-3), { id, tone, message }]);
      window.setTimeout(() => dismiss(id), LIFETIME_MS);
    },
    [dismiss],
  );
  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite" aria-relevant="additions" data-testid="toasts">
        {items.map((item) => (
          <div key={item.id} className={`toast ${item.tone}`}>
            <Icon name={item.tone === "error" || item.tone === "warn" ? "alert" : item.tone === "ok" ? "check" : "info"} />
            <span className="grow">{item.message}</span>
            <button type="button" className="icon-btn" aria-label={t("toast_dismiss")} onClick={() => dismiss(item.id)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
