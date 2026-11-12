import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { Dialog, Spinner, useAsync } from "../../components/common";
import { DiffView } from "../../components/DiffView";
import { Icon } from "../../components/icons";
import { Stepper } from "../../components/Stepper";
import { t, tOr } from "../../i18n";

// "Adicionar ferramenta" > "Própria" (PLAN-extension.md section 4): six steps, keyboard first. The dialog only collects
// choices; the files are produced by the same code as `jgates tools add-custom`, shown as a diff before anything is
// written, and the test runs the one tool once on the synced copy.

const STEPS = ["obtain", "run", "read", "verify", "review", "test"] as const;
type StepId = (typeof STEPS)[number];
type Method = "pip" | "npm" | "apt" | "binary";
type Format = "sarif" | "junit" | "checkstyle" | "exit-code";
const TIMEOUTS = [60, 300, 600, 1800, 3600];
const FORMATS: Format[] = ["sarif", "junit", "checkstyle", "exit-code"];
const FILE_EXT: Record<Format, string> = { sarif: "sarif", junit: "xml", checkstyle: "xml", "exit-code": "" };
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SHA_RE = /^[0-9a-fA-F]{64}$/;

interface Origins {
  installMethods: Method[];
  categories: Array<{ id: string; label: string }>;
  capabilities: Array<{ id: string; category: string; label: string; description: string }>;
}

interface PlanChange {
  file: string;
  existed: boolean;
  diff: string;
}
interface PlanView {
  id: string;
  image: string;
  needsBuild: boolean;
  changes: PlanChange[];
}
interface TestResult {
  state: "ok" | "findings" | "unreadable" | "blocked" | "build-failed" | "not-found";
  reason: string | null;
  findingCount: number;
  blockingCount: number;
  sample: Array<{ rule: string; message: string; severity: string; path: string | null; line: number | null; blocking: boolean }>;
  build: { ok: boolean; built: boolean; error: { message: string } | null } | null;
}

function Refusal({ error }: { error: unknown }) {
  const text =
    error instanceof ApiError
      ? tOr(`ctl_err_${error.code}`, "") !== ""
        ? t(`ctl_err_${error.code}`, { id: String((error.body.params as Record<string, unknown> | undefined)?.id ?? ""), detail: String((error.body.params as Record<string, unknown> | undefined)?.detail ?? "") })
        : error.message
      : t("error_network");
  return (
    <div className="notice error" role="alert" data-testid="ctl-error">
      <Icon name="alert" />
      <p>{text}</p>
    </div>
  );
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[@=<>~^].*$/, "")
    .replace(/^.*\//, "")
    .replace(/\[.*$/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|-+$/g, "");
}

export function CustomToolDialog({ components, existing, preselect, onClose }: { components: string[]; existing: string[]; preselect?: string | null; onClose: (saved: string | null) => void }) {
  const origins = useAsync<Origins>(() => api("GET", "/api/tool-origins"), "custom-origins");
  const [step, setStep] = useState<StepId>("obtain");
  const [source, setSource] = useState<"install" | "image">("install");
  const [image, setImage] = useState("");
  const [method, setMethod] = useState<Method>("pip");
  const [spec, setSpec] = useState("");
  const [url, setUrl] = useState("");
  const [sha, setSha] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  const [imageCheck, setImageCheck] = useState<null | { exists: boolean; architecture: string | null; matches: boolean | null }>(null);
  const [id, setId] = useState("");
  const [idTouched, setIdTouched] = useState(false);
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [component, setComponent] = useState(preselect ?? "");
  const [network, setNetwork] = useState(false);
  const [timeout, setTimeoutSeconds] = useState(600);
  const [format, setFormat] = useState<Format>("sarif");
  const [file, setFile] = useState("");
  const [fileTouched, setFileTouched] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [custom, setCustom] = useState("");
  const [customCaps, setCustomCaps] = useState<string[]>([]);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "check" | "plan" | "save" | "test">(null);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<TestResult | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const installRequest = useMemo(() => {
    if (source !== "install") return null;
    if (method === "binary") return url.trim() && sha.trim() ? `binary:${url.trim()}#sha256=${sha.trim().toLowerCase()}` : null;
    return spec.trim() ? `${method}:${spec.trim()}` : null;
  }, [source, method, spec, url, sha]);

  // The id follows the package (or the command) until the person edits it.
  useEffect(() => {
    if (idTouched) return;
    const base = slug(source === "install" ? (method === "binary" ? (url.split("/").pop() ?? "") : spec) : command);
    setId(base && existing.includes(base) ? `${base}-own` : base);
  }, [idTouched, source, method, spec, url, command, existing]);
  useEffect(() => {
    if (!fileTouched) setFile(FILE_EXT[format] && id ? `${id}.${FILE_EXT[format]}` : "");
  }, [fileTouched, format, id]);

  // The Dockerfile lines of the install request, from the same code as the CLI.
  useEffect(() => {
    setLines([]);
    if (!installRequest) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api<{ lines: string[] }>("POST", "/api/tools/custom/install-lines", { install: [installRequest] }).then(
        (r) => live && setLines(r.lines),
        () => live && setLines([]),
      );
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [installRequest]);

  const capabilities = [...picked, ...customCaps];
  const request = () => ({
    id,
    ...(source === "image" ? { image: image.trim() } : { install: installRequest ? [installRequest] : [] }),
    command: command.trim(),
    args: args.split(/\r?\n/).map((a) => a.trim()).filter((a) => a !== ""),
    report: format === "exit-code" ? { format } : { format, file },
    capabilities,
    ...(component ? { component } : {}),
    network,
    timeoutSeconds: timeout,
  });

  const valid: Record<StepId, boolean> = {
    obtain: source === "image" ? image.trim() !== "" : method === "binary" ? url.trim().startsWith("https://") && SHA_RE.test(sha.trim()) : spec.trim() !== "",
    run: ID_RE.test(id) && command.trim() !== "",
    read: format === "exit-code" || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file),
    verify: capabilities.length > 0,
    review: plan !== null && !error,
    test: true,
  };
  const index = STEPS.indexOf(step);

  // Anything typed or picked and not saved yet: closing asks first (Escape, Close, Cancel).
  const dirty = saved === null && (image.trim() !== "" || spec.trim() !== "" || url.trim() !== "" || sha.trim() !== "" || command.trim() !== "" || args.trim() !== "" || idTouched || fileTouched || picked.length > 0 || customCaps.length > 0 || custom.trim() !== "");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const guard = useRef(false);
  guard.current = dirty;
  const keepEditing = useRef<HTMLButtonElement>(null);
  const requestClose = () => {
    if (!dirty) onClose(saved);
    else setConfirmDiscard(true);
  };
  useEffect(() => {
    if (confirmDiscard) keepEditing.current?.focus();
  }, [confirmDiscard]);
  // The platform closes a <dialog> on Escape; with typed content the cancel is refused (and a close that happens anyway,
  // like a second Escape in some browsers, reopens it) so the question below is what answers.
  useEffect(() => {
    const dialog = () => root.current?.closest("dialog") ?? null;
    const onCancel = (e: Event) => {
      if (guard.current && e.target === dialog()) e.preventDefault();
    };
    const onClosed = (e: Event) => {
      const d = dialog();
      if (guard.current && d && e.target === d && !d.open) d.showModal();
    };
    document.addEventListener("cancel", onCancel, true);
    document.addEventListener("close", onClosed, true);
    return () => {
      document.removeEventListener("cancel", onCancel, true);
      document.removeEventListener("close", onClosed, true);
    };
  }, []);

  const go =(next: StepId) => {
    setError(null);
    setStep(next);
  };
  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  async function loadPlan() {
    setBusy("plan");
    setError(null);
    setPlan(null);
    try {
      // A tool saved by this dialog is replaced, not refused: its entry goes away first (the Dockerfile lines stay, once).
      if (saved) {
        await api("DELETE", `/api/tools/${encodeURIComponent(saved)}`);
        setSaved(null);
      }
      const r = await api<{ plan: PlanView }>("POST", "/api/tools/custom/preview", request());
      setPlan(r.plan);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  async function next() {
    const to = STEPS[index + 1];
    if (!to) return;
    go(to);
    if (to === "review") await loadPlan();
  }
  async function checkImage() {
    setBusy("check");
    setError(null);
    try {
      setImageCheck(await api("POST", "/api/tools/custom/check-image", { image: image.trim() }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  async function save() {
    setBusy("save");
    setError(null);
    try {
      await api("POST", "/api/tools/custom/save", request());
      setSaved(id);
      setResult(null);
      go("test");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  async function runTest() {
    setBusy("test");
    setError(null);
    setResult(null);
    try {
      const r = await api<{ result: TestResult }>("POST", "/api/tools/custom/test", { instance: id });
      setResult(r.result);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  }
  const addCustom = () => {
    const name = custom.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+|-+$/g, "");
    if (!name) return;
    const capId = `x-custom:${name}`;
    setCustom("");
    setCustomCaps((old) => (old.includes(capId) ? old : [...old, capId]));
  };

  const grouped = (origins.data?.categories ?? [])
    .map((c) => ({ ...c, items: (origins.data?.capabilities ?? []).filter((x) => x.category === c.id) }))
    .filter((g) => g.items.length > 0);

  const stepper = STEPS.map((s, i) => ({ id: s, label: t(`ctl_step_${s}`), done: i < index, disabled: i > index && !(saved && s === "test") }));

  return (
    <Dialog title={t("ctl_title")} onClose={requestClose} wide>
      <div className="stack" data-testid="custom-tool-dialog" data-step={step} ref={root}>
        {confirmDiscard ? (
          <div className="notice warn" role="alert" data-testid="ctl-discard">
            <Icon name="alert" />
            <div className="stack tight grow">
              <strong>{t("ctl_discard_title")}</strong>
              <p className="small">{t("ctl_discard_lead")}</p>
              <div className="row wrap">
                <button type="button" className="btn primary" ref={keepEditing} data-testid="ctl-keep" onClick={() => setConfirmDiscard(false)}>
                  {t("ctl_discard_keep")}
                </button>
                <button type="button" className="btn danger" data-testid="ctl-discard-yes" onClick={() => onClose(saved)}>
                  {t("ctl_discard_yes")}
                </button>
              </div>
            </div>
          </div>
        ) : null}
        <Stepper steps={stepper} current={step} onSelect={(s) => go(s as StepId)} label={t("ctl_steps_label")} />
        <h3 ref={heading} tabIndex={-1} id="ctl-step-title">
          {t("ctl_step_n", { n: index + 1, total: STEPS.length, name: t(`ctl_step_${step}`) })}
        </h3>
        {origins.error ? <Refusal error={origins.error} /> : null}

        {step === "obtain" ? (
          <fieldset className="stack tight">
            <legend className="small">{t("ctl_obtain_legend")}</legend>
            <label className="row">
              <input type="radio" name="ctl-source" value="image" checked={source === "image"} onChange={() => setSource("image")} />
              <span>{t("ctl_obtain_image")}</span>
            </label>
            <label className="row">
              <input type="radio" name="ctl-source" value="install" checked={source === "install"} onChange={() => setSource("install")} />
              <span>{t("ctl_obtain_install")}</span>
            </label>
            {source === "image" ? (
              <div className="stack tight">
                <label className="stack tight">
                  <span className="small">{t("ctl_image_label")}</span>
                  <input className="input" type="text" data-free-text="image-reference" value={image} autoComplete="off" spellCheck={false} placeholder="ghcr.io/acme/scanner:2.1" onChange={(e) => (setImage(e.target.value), setImageCheck(null))} />
                </label>
                <div className="row wrap">
                  <button type="button" className="btn" disabled={image.trim() === "" || busy !== null} onClick={checkImage}>
                    {busy === "check" ? <Spinner /> : null}
                    {t("ctl_image_check")}
                  </button>
                  {imageCheck ? (
                    <span className="small" role="status" data-testid="ctl-image-check">
                      {!imageCheck.exists ? t("ctl_image_missing") : imageCheck.matches === false ? t("ctl_image_arch_bad", { arch: imageCheck.architecture ?? "?" }) : imageCheck.matches === true ? t("ctl_image_ok", { arch: imageCheck.architecture ?? "amd64" }) : t("ctl_image_exists")}
                    </span>
                  ) : null}
                </div>
                <p className="small muted">{t("ctl_image_note")}</p>
              </div>
            ) : (
              <div className="stack tight">
                <label className="stack tight">
                  <span className="small">{t("ctl_method_label")}</span>
                  <select className="input" data-testid="ctl-method" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                    {(origins.data?.installMethods ?? ["pip", "npm", "apt", "binary"]).map((m) => (
                      <option key={m} value={m}>
                        {t(`ctl_method_${m}`)}
                      </option>
                    ))}
                  </select>
                </label>
                {method === "binary" ? (
                  <>
                    <label className="stack tight">
                      <span className="small">{t("ctl_binary_url")}</span>
                      <input className="input" type="text" data-free-text="download-url" value={url} autoComplete="off" spellCheck={false} onChange={(e) => setUrl(e.target.value)} />
                    </label>
                    <label className="stack tight">
                      <span className="small">{t("ctl_binary_sha")}</span>
                      <input className="input" type="text" data-free-text="checksum" value={sha} autoComplete="off" spellCheck={false} onChange={(e) => setSha(e.target.value)} />
                    </label>
                  </>
                ) : (
                  <label className="stack tight">
                    <span className="small">{t("ctl_spec_label")}</span>
                    <input className="input" type="text" data-free-text="package-spec" value={spec} autoComplete="off" spellCheck={false} placeholder={method === "pip" ? "bandit==1.8.0" : method === "npm" ? "eslint@9" : "cppcheck"} onChange={(e) => setSpec(e.target.value)} />
                  </label>
                )}
                {lines.length > 0 ? (
                  <div className="stack tight" data-testid="ctl-lines">
                    <span className="small">{t("ctl_lines_title")}</span>
                    <pre className="svc-log">{lines.join("\n")}</pre>
                  </div>
                ) : null}
              </div>
            )}
          </fieldset>
        ) : null}

        {step === "run" ? (
          <div className="stack">
            <label className="stack tight">
              <span>{t("ctl_id_label")}</span>
              <input className="input" type="text" data-free-text="tool-id" data-testid="ctl-id" value={id} autoComplete="off" spellCheck={false} aria-describedby="ctl-id-help" onChange={(e) => (setIdTouched(true), setId(e.target.value))} />
              <span className="small muted" id="ctl-id-help">
                {t("tools_dialog_id_help")}
              </span>
            </label>
            <label className="stack tight">
              <span>{t("ctl_command_label")}</span>
              <input className="input" type="text" data-free-text="command" data-testid="ctl-command" value={command} autoComplete="off" spellCheck={false} placeholder="bandit" onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className="stack tight">
              <span>{t("ctl_args_label")}</span>
              <textarea className="input" data-free-text="arguments" data-testid="ctl-args" rows={4} value={args} spellCheck={false} aria-describedby="ctl-args-help" onChange={(e) => setArgs(e.target.value)} />
              <span className="small muted" id="ctl-args-help">
                {t("ctl_args_help")}
              </span>
            </label>
            <ul className="small ctl-placeholders">
              <li>
                <code>{"{workspace}"}</code> {t("ctl_ph_workspace")}
              </li>
              <li>
                <code>{"{component}"}</code> {t("ctl_ph_component")}
              </li>
              <li>
                <code>{"{output}"}</code> {t("ctl_ph_output")}
              </li>
            </ul>
            <label className="stack tight">
              <span>{t("ctl_component_label")}</span>
              <select className="input" data-testid="ctl-component" value={component} onChange={(e) => setComponent(e.target.value)}>
                <option value="">{t("tools_dialog_component_none")}</option>
                {components.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <div className="row wrap">
              <label className="stack tight">
                <span className="small">{t("ctl_timeout")}</span>
                <select className="input" data-testid="ctl-timeout" value={timeout} onChange={(e) => setTimeoutSeconds(Number(e.target.value))}>
                  {TIMEOUTS.map((s) => (
                    <option key={s} value={s}>
                      {t("svc_timeout_option", { seconds: s })}
                    </option>
                  ))}
                </select>
              </label>
              <label className="row">
                <input type="checkbox" checked={network} onChange={(e) => setNetwork(e.target.checked)} />
                <span className="small">{t("ctl_network")}</span>
              </label>
            </div>
          </div>
        ) : null}

        {step === "read" ? (
          <fieldset className="stack tight">
            <legend className="small">{t("ctl_read_legend")}</legend>
            {FORMATS.map((f) => (
              <label key={f} className="row">
                <input type="radio" name="ctl-format" value={f} checked={format === f} onChange={() => setFormat(f)} />
                <span>
                  <strong>{t(`ctl_format_${f.replace("-", "_")}`)}</strong> {f === "sarif" ? <em className="small">{t("ctl_recommended")}</em> : null}
                  <span className="small muted"> {t(`ctl_format_${f.replace("-", "_")}_help`)}</span>
                </span>
              </label>
            ))}
            {format !== "exit-code" ? (
              <label className="stack tight">
                <span className="small">{t("ctl_file_label")}</span>
                <input className="input" type="text" data-free-text="report-file" data-testid="ctl-file" value={file} autoComplete="off" spellCheck={false} aria-describedby="ctl-file-help" onChange={(e) => (setFileTouched(true), setFile(e.target.value))} />
                <span className="small muted" id="ctl-file-help">
                  {t("ctl_file_help", { file: file || "result" })}
                </span>
              </label>
            ) : null}
          </fieldset>
        ) : null}

        {step === "verify" ? (
          <div className="stack">
            <p className="small">{t("ctl_verify_lead")}</p>
            {grouped.map((g) => (
              <fieldset key={g.id} className="stack tight">
                <legend className="small">{g.label}</legend>
                {g.items.map((c) => (
                  <label key={c.id} className="row">
                    <input type="checkbox" data-capability={c.id} checked={picked.includes(c.id)} onChange={(e) => setPicked((old) => (e.target.checked ? [...old, c.id] : old.filter((x) => x !== c.id)))} />
                    <span>
                      {c.label} <span className="small muted">{c.description}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
            <fieldset className="stack tight">
              <legend className="small">{t("ctl_custom_cap_title")}</legend>
              {customCaps.map((c) => (
                <label key={c} className="row">
                  <input type="checkbox" data-capability={c} checked onChange={() => setCustomCaps((old) => old.filter((x) => x !== c))} />
                  <span>{c.replace("x-custom:", "")}</span>
                </label>
              ))}
              <div className="row wrap">
                <label className="stack tight grow">
                  <span className="small">{t("ctl_custom_cap_label")}</span>
                  <input
                    className="input"
                    type="text"
                    data-free-text="capability-name"
                    value={custom}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addCustom();
                      }
                    }}
                  />
                </label>
                <button type="button" className="btn" disabled={custom.trim() === ""} onClick={addCustom}>
                  {t("ctl_custom_cap_add")}
                </button>
              </div>
            </fieldset>
          </div>
        ) : null}

        {step === "review" ? (
          <div className="stack" aria-live="polite">
            {busy === "plan" ? (
              <p>
                <Spinner /> {t("ctl_review_loading")}
              </p>
            ) : null}
            {plan ? (
              <>
                <p>{t("ctl_review_lead", { id: plan.id })}</p>
                {plan.changes.map((c) => (
                  <section key={c.file} className="stack tight" data-testid="ctl-diff" data-file={c.file}>
                    <h4>
                      <code>{c.file}</code> <span className="small muted">{c.existed ? t("ctl_review_changed") : t("ctl_review_new")}</span>
                    </h4>
                    <DiffView diff={c.diff} />
                  </section>
                ))}
                <ul className="small ctl-placeholders" data-testid="ctl-effects">
                  <li>{network ? t("ctl_effect_network") : t("ctl_effect_no_network")}</li>
                  <li>{plan.needsBuild ? t("ctl_effect_build") : t("ctl_effect_no_build")}</li>
                  <li>{t("ctl_effect_untested")}</li>
                </ul>
              </>
            ) : null}
          </div>
        ) : null}

        {step === "test" ? (
          <div className="stack" aria-live="polite">
            <div className="notice ok" role="status" data-testid="ctl-saved">
              <Icon name="check" />
              <p>{t("ctl_saved", { id })}</p>
            </div>
            <p>{t("ctl_test_lead")}</p>
            <div className="row wrap">
              <button type="button" className="btn primary" data-testid="ctl-test" disabled={busy !== null} onClick={runTest}>
                {busy === "test" ? <Spinner /> : <Icon name="play" />}
                {busy === "test" ? t("ctl_test_running") : t("ctl_test_now")}
              </button>
            </div>
            {busy === "test" ? <p className="small muted">{t("ctl_test_progress")}</p> : null}
            {result ? (
              <div className={`notice ${result.state === "ok" || result.state === "findings" ? "ok" : "warn"}`} role="status" data-testid="ctl-test-result" data-state={result.state}>
                <Icon name={result.state === "ok" || result.state === "findings" ? "check" : "alert"} />
                <div className="stack tight grow">
                  <strong>{t(`ctl_result_${result.state.replace("-", "_")}`, { count: result.findingCount })}</strong>
                  {result.reason ? <p className="small">{result.reason}</p> : null}
                  {result.build?.error ? <p className="small">{result.build.error.message}</p> : null}
                  {result.sample.length > 0 ? (
                    <ul className="small">
                      {result.sample.map((f, i) => (
                        <li key={i}>
                          <code>{f.rule}</code> {f.message} {f.path ? <code>{f.path}{f.line ? `:${f.line}` : ""}</code> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {result.state === "unreadable" || result.state === "build-failed" || result.state === "blocked" ? (
                    <div>
                      <button type="button" className="btn" data-testid="ctl-adjust" onClick={() => go("obtain")}>
                        {t("ctl_adjust")}
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {error ? <Refusal error={error} /> : null}

        <div className="row wrap">
          {index > 0 && step !== "test" ? (
            <button type="button" className="btn" onClick={() => go(STEPS[index - 1] as StepId)} disabled={busy !== null}>
              {t("ctl_back")}
            </button>
          ) : null}
          {step === "review" ? (
            <button type="button" className="btn primary" data-testid="ctl-save" disabled={!valid.review || busy !== null} onClick={save}>
              <Icon name="check" />
              {busy === "save" ? t("svc_saving") : t("ctl_save")}
            </button>
          ) : step === "test" ? (
            <button type="button" className="btn" data-testid="ctl-done" disabled={busy === "test"} onClick={() => onClose(saved)}>
              {t("ctl_done")}
            </button>
          ) : (
            <button type="button" className="btn primary" data-testid="ctl-next" disabled={!valid[step] || busy !== null} onClick={next}>
              {t("ctl_next")}
            </button>
          )}
          <button type="button" className="btn" onClick={requestClose}>
            {t("tools_dialog_cancel")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
