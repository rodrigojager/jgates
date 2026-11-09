import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { ErrorNotice, Loading } from "../../components/common";
import { Icon } from "../../components/icons";
import { t, tOr } from "../../i18n";
import { formatDuration } from "../validations-result/ResultView";
import { groupLogs, isBlank, parseLog, type CommandFact, type LogFile, type LogGroup, type Stream } from "./log-parts";
import "./step-log.css";

/** The pages of one log file, read on demand (offset/next/done), the first page as soon as it mounts. */
function useLogPages(runId: string, name: string | undefined) {
  const [text, setText] = useState("");
  const [next, setNext] = useState(0);
  const [done, setDone] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);
  async function more() {
    if (!name) return;
    try {
      const r = await api("GET", `/api/results/${runId}/logs/${encodeURIComponent(name)}?offset=${next}`);
      setText((old) => old + r.text);
      setNext(r.next);
      setDone(r.done);
      setLoaded(true);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    if (started.current || !name) return;
    started.current = true;
    void more();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { text, done, loaded, error, more };
}

function shellWord(word: string): string {
  return word === "" || /[\s"'`$&|<>;()]/.test(word) ? JSON.stringify(word) : word;
}

function factValue(fact: CommandFact): string {
  if (fact.key === "args") {
    try {
      const args = JSON.parse(fact.value);
      if (Array.isArray(args)) return args.map((a) => shellWord(String(a))).join(" ");
    } catch {
      // Shown as written.
    }
  }
  if (fact.key === "duration ms" && /^\d+$/.test(fact.value)) return formatDuration(Number(fact.value));
  if (fact.value === "(none)") return t("vrun_logs_fact_none");
  return fact.value;
}

const factKey = (key: string): string => key.replace(/\s+/g, "_");

function FactList({ facts }: { facts: CommandFact[] }) {
  return (
    <dl className="log-facts">
      {facts.map((f, i) =>
        f.value === "" ? (
          <div key={i}>
            <dt>{t("vrun_logs_fact_note")}</dt>
            <dd>{tOr(`vrun_logs_flag_${factKey(f.key)}`, f.key)}</dd>
          </div>
        ) : (
          <div key={i}>
            <dt>{tOr(`vrun_logs_fact_${factKey(f.key)}`, f.key)}</dt>
            <dd>
              <code>{factValue(f)}</code>
            </dd>
          </div>
        ),
      )}
    </dl>
  );
}

function StreamView({ stream, title, page }: { stream: Stream; title: string; page: ReturnType<typeof useLogPages> }) {
  const parsed = parseLog(page.text, page.done);
  const label = t(stream === "stdout" ? "vrun_logs_stdout" : "vrun_logs_stderr");
  return (
    <div className="log-stream" data-stream={stream}>
      <strong className="small">{label}</strong>
      {page.error ? <ErrorNotice error={page.error} onRetry={page.more} /> : null}
      {!page.loaded && !page.error ? <Loading /> : null}
      {page.loaded && page.done && isBlank(parsed.body) ? (
        <p className="small muted log-none" data-testid="log-none">
          {t("vrun_logs_none")}
        </p>
      ) : page.loaded ? (
        <pre className="log" tabIndex={0} aria-label={t("vrun_logs_stream_of", { stream: label, tool: title })}>
          {parsed.body}
        </pre>
      ) : null}
      {page.loaded && !page.done ? (
        <div>
          <button type="button" className="btn" onClick={page.more} aria-label={t("vrun_logs_more_of", { stream: label.toLowerCase(), tool: title })}>
            {t("vrun_logs_more")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function BlockBody({ runId, group, title }: { runId: string; group: LogGroup; title: string }) {
  const out = useLogPages(runId, group.files.stdout?.name);
  const err = useLogPages(runId, group.files.stderr?.name);
  const errParsed = parseLog(err.text, err.done);
  const outParsed = parseLog(out.text, out.done);
  const facts = [...errParsed.facts, ...outParsed.facts];
  const trailer = [...errParsed.trailer, ...outParsed.trailer];
  return (
    <div className="log-block-body">
      {facts.length > 0 || trailer.length > 0 ? (
        <details className="log-command" data-testid="log-command">
          <summary>{t("vrun_logs_command")}</summary>
          <p className="small muted">{t("vrun_logs_command_hint")}</p>
          {facts.length > 0 ? <FactList facts={facts} /> : null}
          {trailer.length > 0 ? (
            <>
              <strong className="small">{t("vrun_logs_trailer")}</strong>
              <FactList facts={trailer} />
            </>
          ) : null}
        </details>
      ) : null}
      {group.files.stdout ? <StreamView stream="stdout" title={title} page={out} /> : null}
      {group.files.stderr ? <StreamView stream="stderr" title={title} page={err} /> : null}
    </div>
  );
}

function LogBlock({ runId, group, title, startOpen, failed }: { runId: string; group: LogGroup; title: string; startOpen: boolean; failed: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <details
      className="log-block"
      data-testid="log-block"
      data-invocation={group.invocation}
      data-failed={failed || undefined}
      open={startOpen}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>
        <span className="log-block-title">{title}</span>
        {group.invocation.toLowerCase() !== title.toLowerCase() ? <code className="log-block-id">{group.invocation}</code> : null}
      </summary>
      {open ? <BlockBody runId={runId} group={group} title={title} /> : null}
    </details>
  );
}

/**
 * The logs of one step: one block per tool invocation, named after it, with its standard and error output inside;
 * the command JGates ran in a collapsed disclosure. The step's own block comes first and opens by itself; in a step
 * that failed every block opens and is highlighted.
 */
export function StepLogPanel({ runId, stepId, label, failed, id }: { runId: string; stepId: string; label: string; failed: boolean; id: string }) {
  const [files, setFiles] = useState<LogFile[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  async function load() {
    try {
      const r = await api("GET", `/api/results/${runId}/logs`);
      setFiles(r.logs as LogFile[]);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, stepId]);
  const groups = files ? groupLogs(stepId, files) : [];
  return (
    <div className="step-log" id={id} role="region" aria-label={t("vrun_logs_region", { step: label })} data-failed={failed || undefined}>
      {failed ? (
        <p className="step-log-failed small">
          <Icon name="alert" />
          <span>{t("vrun_logs_failed")}</span>
        </p>
      ) : null}
      <p className="step-log-note small muted" data-testid="log-note">
        <Icon name="info" />
        <span>{t("vrun_logs_note")}</span>
      </p>
      {error ? <ErrorNotice error={error} onRetry={load} /> : null}
      {!files && !error ? <Loading /> : null}
      {files && groups.length === 0 ? <p className="small">{t("vrun_logs_empty")}</p> : null}
      {groups.map((g, i) => (
        <LogBlock
          key={g.invocation}
          runId={runId}
          group={g}
          title={g.part === null ? label : t("vrun_logs_part_title", { step: label, part: tOr(`vrun_logs_part_${g.part}`, g.part) })}
          startOpen={failed || i === 0}
          failed={failed}
        />
      ))}
    </div>
  );
}
