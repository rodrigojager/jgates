import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiError, api } from "../api";

/** What GET /api/shell answers: everything the frame of the application shows. */
export interface ShellInfo {
  version: string;
  mode: "local" | "governed";
  governed: { policy: string; shaPinned: boolean } | null;
  /** The interface edits a CI policy folder (jgates ui --policy), not a project. */
  policyMode: boolean;
  workspace: { id: string; name: string; path: string; configured: boolean };
  git: { branch: string | null; detached: boolean; commit: string | null; dirty: boolean | null } | null;
  runs: { count: number; active: { id: string; startedAt: string } | null };
  workspaces: WorkspaceChoice[];
}

export interface WorkspaceChoice {
  id: string;
  name: string;
  path: string;
  lastAccess: string;
  current: boolean;
  exists: boolean;
  branch: string | null;
}

/**
 * Link with the local server: "ok"; "stopped" (it does not answer any more); "expired" (it answers but the session is
 * gone: the server was restarted or the session idled out).
 */
export type Connection = "ok" | "stopped" | "expired";

interface ShellApi {
  info: ShellInfo | null;
  connection: Connection;
  /** Reads the shell data again (after a change the frame shows, or when the user asks). */
  reload(): Promise<void>;
  /** Asks the server whether it still answers; sets `connection`. */
  probe(): Promise<Connection>;
}

const ShellContext = createContext<ShellApi>({ info: null, connection: "ok", reload: async () => undefined, probe: async () => "ok" });

export const useShell = (): ShellApi => useContext(ShellContext);

/** Event a screen (or ErrorNotice) fires when a request failed without an answer, so the shell checks the server now. */
export const PROBE_EVENT = "jgates:probe";

const REFRESH_MS = 10_000;
const DOWN_REFRESH_MS = 3_000;

async function ping(): Promise<Connection> {
  try {
    const response = await fetch("/api/session", { credentials: "same-origin", headers: { Accept: "application/json" }, cache: "no-store" });
    return response.status === 401 ? "expired" : "ok";
  } catch {
    return "stopped";
  }
}

export function ShellProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<ShellInfo | null>(null);
  const [connection, setConnection] = useState<Connection>("ok");
  const busy = useRef(false);

  const probe = useCallback(async () => {
    const state = await ping();
    setConnection(state);
    return state;
  }, []);

  const reload = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await api<ShellInfo>("GET", "/api/shell");
      setInfo(next);
      setConnection("ok");
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.status === 401) setConnection("expired");
        // Any other answer proves the server is there; the frame keeps what it had.
        else setConnection("ok");
      } else {
        await probe();
      }
    } finally {
      busy.current = false;
    }
  }, [probe]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Refresh while the tab is in front; faster while the server is down so the screen recovers by itself.
  useEffect(() => {
    const every = connection === "ok" ? REFRESH_MS : DOWN_REFRESH_MS;
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      if (connection === "ok") void reload();
      else void probe().then((state) => (state === "ok" ? reload() : undefined));
    };
    const timer = window.setInterval(tick, every);
    const onFocus = () => tick();
    const onProbe = () => void probe();
    window.addEventListener("focus", onFocus);
    window.addEventListener(PROBE_EVENT, onProbe);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(PROBE_EVENT, onProbe);
    };
  }, [connection, reload, probe]);

  const value = useMemo(() => ({ info, connection, reload, probe }), [info, connection, reload, probe]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}
