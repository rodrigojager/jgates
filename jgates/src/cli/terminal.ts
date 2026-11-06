// How `jgates run` talks to a terminal. Two styles:
//   - pretty: a person at a terminal. Colors, ✓ ✗ – marks and one live line for the step in progress (a spinner, the
//     elapsed time and the last file the run wrote), redrawn in place on stderr.
//   - plain: an agent, a log, CI or a pipe. No ANSI, no redrawing: one line per event and, while a long step runs,
//     one "still running" line a minute, so a reader knows the run did not hang.
// Pretty only when stderr is a terminal and nothing asks for plain (--plain, NO_COLOR, CI, TERM=dumb); --pretty
// forces it. --json never prints progress at all (stdout is one JSON document).
import type { RunEvent } from "../core/events/index.js";
import { lastActivity } from "../core/run/heartbeat.js";
import { translator } from "../i18n/index.js";

export interface TerminalStyle {
  /** ANSI colors and marks. */
  color: boolean;
  /** One line redrawn in place for the running step. */
  live: boolean;
}

export function terminalStyle(options: Record<string, string | boolean>, env: NodeJS.ProcessEnv = process.env, isTTY = process.stderr.isTTY === true): TerminalStyle {
  if (options.pretty === true) return { color: true, live: true };
  const plain = options.plain === true || env.NO_COLOR !== undefined || (env.CI !== undefined && env.CI !== "" && env.CI !== "false") || env.TERM === "dumb" || !isTTY;
  return plain ? { color: false, live: false } : { color: true, live: true };
}

const CODES = { bold: 1, dim: 2, red: 31, green: 32, yellow: 33, blue: 34, cyan: 36 } as const;
export type Paint = keyof typeof CODES;

export function paint(style: TerminalStyle, kind: Paint, text: string): string {
  return style.color ? `\u001b[${CODES[kind]}m${text}\u001b[0m` : text;
}

/** "820 ms", "14s", "2m 05s", "1h 03m". */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** The mark and color of a step or stage state. */
export function stateMark(state: string): { mark: string; color: Paint } {
  if (["completed", "passed", "succeeded", "ok"].includes(state)) return { mark: "✓", color: "green" };
  if (["failed", "error", "timeout", "blocked", "invalid"].includes(state)) return { mark: "✗", color: "red" };
  if (["disabled", "not_applicable", "skipped", "not-run"].includes(state)) return { mark: "–", color: "dim" };
  return { mark: "!", color: "yellow" };
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Plain style: one line a minute while a step runs. */
const PLAIN_HEARTBEAT_MS = 60_000;
const LIVE_FRAME_MS = 120;
const ACTIVITY_EVERY_MS = 2_000;

/**
 * The progress of one run on stderr, driven by the run's events. `stop()` clears the live line and the timers; call
 * it before printing the final summary.
 */
export class RunProgress {
  private readonly running = new Map<string, { label: string; startedAt: number }>();
  private runDir: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private liveShown = false;
  private lastPlainBeat = 0;
  private activity: { file: string | null; at: string | null } = { file: null, at: null };
  private activityReadAt = 0;
  private readonly t = translator("run");

  constructor(
    private readonly write: (text: string) => void,
    private readonly style: TerminalStyle,
    private readonly now: () => number = Date.now,
  ) {}

  onEvent(event: RunEvent): void {
    const d = event.data;
    const step = String(d.step ?? "");
    switch (event.type) {
      case "run-started":
        this.runDir = typeof d.runDir === "string" ? d.runDir : null;
        return;
      case "step-started": {
        const label = typeof d.label === "string" && d.label !== step ? `${step} (${d.label})` : step;
        this.running.set(step, { label, startedAt: this.now() });
        this.line(`${this.mark("›", "cyan")}${this.t("run_progress_started", { step: label })}`);
        this.ensureTimer();
        return;
      }
      case "step-finished": {
        const entry = this.running.get(step);
        this.running.delete(step);
        const status = String(d.status ?? "");
        const elapsed = formatElapsed(typeof d.durationMs === "number" ? d.durationMs : entry ? this.now() - entry.startedAt : NaN);
        const { mark, color } = stateMark(status);
        this.line(`${this.mark(mark, color)}${this.t("run_progress_finished", { step: entry?.label ?? step, status: paint(this.style, color, status), elapsed })}`);
        if (this.running.size === 0) this.stopTimer();
        return;
      }
      case "step-skipped":
        this.line(`${this.mark("–", "dim")}${this.t("run_progress_skipped", { step, cause: String(d.cause ?? "-") })}`);
        return;
      case "cancel-requested":
        this.line(`${this.mark("!", "yellow")}${paint(this.style, "yellow", this.t("run_cancel_requested"))}`);
        return;
      default:
        return;
    }
  }

  stop(): void {
    this.stopTimer();
    this.clearLive();
  }

  /** A mark before a line, only in the pretty style (an agent's log gets no decoration). */
  private mark(text: string, color: Paint): string {
    return this.style.color ? `${paint(this.style, color, text)} ` : "";
  }

  /** Prints a whole line, above the live line when there is one. */
  private line(text: string): void {
    this.clearLive();
    this.write(`${text}\n`);
    this.drawLive();
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.lastPlainBeat = this.now();
    this.timer = setInterval(() => this.tick(), this.style.live ? LIVE_FRAME_MS : 5_000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.running.size === 0) return;
    if (this.style.live) {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.clearLive();
      this.drawLive();
      return;
    }
    if (this.now() - this.lastPlainBeat >= PLAIN_HEARTBEAT_MS) {
      this.lastPlainBeat = this.now();
      this.write(`${this.status()}\n`);
    }
  }

  /** "quality-bridge: em andamento há 2m 03s · última saída: X, há 5s". */
  private status(): string {
    const entries = [...this.running.values()];
    const oldest = Math.min(...entries.map((e) => e.startedAt));
    const names = entries.map((e) => e.label).join(", ");
    return this.t("run_progress_running", { step: names, elapsed: formatElapsed(this.now() - oldest), activity: this.activityText() });
  }

  private activityText(): string {
    if (!this.runDir) return "";
    if (this.now() - this.activityReadAt >= ACTIVITY_EVERY_MS) {
      this.activityReadAt = this.now();
      this.activity = lastActivity(this.runDir);
    }
    if (!this.activity.file || !this.activity.at) return "";
    const file = this.activity.file.split("/").slice(-1)[0] ?? this.activity.file;
    return this.t("run_progress_activity", { file, ago: formatElapsed(Math.max(0, this.now() - Date.parse(this.activity.at))) });
  }

  private drawLive(): void {
    if (!this.style.live || this.running.size === 0) return;
    const columns = process.stderr.columns && process.stderr.columns > 20 ? process.stderr.columns - 1 : 100;
    const text = `${SPINNER[this.frame]} ${this.status()}`;
    const cut = text.length > columns ? `${text.slice(0, columns - 1)}…` : text;
    this.write(paint(this.style, "cyan", cut));
    this.liveShown = true;
  }

  private clearLive(): void {
    if (!this.liveShown) return;
    this.write("\r\u001b[2K");
    this.liveShown = false;
  }
}
