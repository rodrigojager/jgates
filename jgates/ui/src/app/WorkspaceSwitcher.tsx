import { useRef, useState } from "react";
import { api } from "../api";
import { Dialog, errorText } from "../components/common";
import { Icon } from "../components/icons";
import { useToast } from "../components/Toast";
import { t } from "../i18n";
import { useShell, type WorkspaceChoice } from "./shell-context";

/**
 * Button of the sidebar plus the dialog behind it. A session serves one workspace, so choosing another asks the server
 * for a one-time link to that workspace's own server and opens it in a new tab.
 */
export function WorkspaceSwitcher() {
  const { info } = useShell();
  const [open, setOpen] = useState(false);
  const name = info?.workspace.name ?? "";
  // A server that edits the CI policy serves that folder only: there is no other workspace to switch to.
  if (info?.policyMode) {
    return (
      <div className="workspace-switch" data-testid="policy-workspace">
        <span className="avatar" aria-hidden="true" data-letter={name.slice(0, 1).toLowerCase()} />
        <span className="grow">
          <strong>{name}</strong>
          <small>{t("ws_policy")}</small>
        </span>
      </div>
    );
  }
  return (
    <>
      <button
        type="button"
        className="workspace-switch"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span className="avatar" aria-hidden="true" data-letter={name.slice(0, 1).toLowerCase()} />
        <span className="grow">
          <strong>{name}</strong>
          <small>{t("ws_local")}</small>
        </span>
        <Icon name="chevrons" />
        <span className="sr-only">{t("ws_switch")}</span>
      </button>
      {open ? <SwitchDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

interface Opened {
  url: string;
  name: string;
}

function SwitchDialog({ onClose }: { onClose: () => void }) {
  const { info } = useShell();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; fix: string | null } | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [folder, setFolder] = useState("");
  const link = useRef<HTMLAnchorElement>(null);

  const open = async (key: string, body: { id: string } | { path: string }, label: string) => {
    setBusy(key);
    setError(null);
    try {
      const answer = await api<{ url: string; workspace: { name: string } }>("POST", "/api/workspaces/open", body);
      const target = { url: answer.url, name: answer.workspace.name || label };
      setOpened(target);
      toast(t("ws_opened", { name: target.name }), "ok");
      // Opening from a script right after the click keeps the user gesture; the visible link below is the fallback.
      const anchor = document.createElement("a");
      anchor.href = target.url;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      anchor.click();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const choices: WorkspaceChoice[] = info?.workspaces ?? [];
  return (
    <Dialog title={t("ws_dialog_title")} onClose={onClose}>
      <p>{t("ws_note")}</p>
      <ul className="ws-list" aria-label={t("ws_list")}>
        {choices.map((w) => (
          <li key={w.id} className={`ws-item${w.current ? " current" : ""}`} data-workspace={w.id}>
            <span className="avatar" aria-hidden="true" data-letter={w.name.slice(0, 1).toLowerCase()} />
            <div className="grow">
              <strong>{w.name}</strong>
              <div className="small muted mono">{w.path}</div>
              <div className="small muted">
                {w.exists ? (
                  <>
                    <Icon name="branch" />
                    {w.branch ?? t("ws_no_branch")}
                  </>
                ) : (
                  t("ws_missing")
                )}
              </div>
            </div>
            {w.current ? (
              <span className="pill green">{t("ws_current")}</span>
            ) : (
              <button type="button" className="btn" disabled={!w.exists || busy !== null} aria-label={t("ws_open", { name: w.name })} onClick={() => open(w.id, { id: w.id }, w.name)}>
                {busy === w.id ? t("ws_opening") : t("ws_open_short")}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form
        className="stack ws-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (folder.trim() !== "") void open("path", { path: folder.trim() }, folder.trim());
        }}
      >
        <label className="stack" htmlFor="ws-path">
          <span className="field-label">{t("ws_path_label")}</span>
          <input id="ws-path" type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder={t("ws_path_placeholder")} spellCheck={false} autoComplete="off" />
          <span className="small muted">{t("ws_path_hint")}</span>
        </label>
        <div>
          <button type="submit" className="btn" disabled={folder.trim() === "" || busy !== null}>
            {busy === "path" ? t("ws_opening") : t("ws_path_button")}
          </button>
        </div>
      </form>
      {error ? (
        <div className="notice error" role="alert">
          <Icon name="alert" />
          <div className="grow">
            <p>{error.message}</p>
            {error.fix ? <p className="small">{error.fix}</p> : null}
          </div>
        </div>
      ) : null}
      {opened ? (
        <div className="notice ok" role="status">
          <Icon name="check" />
          <div className="grow">
            <p>{t("ws_opened", { name: opened.name })}</p>
            <p className="small">
              {t("ws_opened_fallback")}{" "}
              <a ref={link} href={opened.url} target="_blank" rel="noopener">
                {t("ws_opened_link", { name: opened.name })}
              </a>
            </p>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}
