// The reasons catalogue: the one place that maps a reason code (PLAN-guided-ux.md section 9) to its text in both
// languages and to its one action. The CLI, the plan, the run and the server (and, through the plan and run results,
// the UI) read it; a task that introduces a code adds an entry here and its two texts in reasons.{pt-BR,en}.json.
// Raw engine text never goes into the main text: callers keep it in `details`.
import { getLocale, translator, type Params } from "../../i18n/index.js";

export type ReasonActionKind = "command" | "link" | "route" | "none";

/** What the action points at: a CLI command, an official page, a screen of the UI, or nothing a program can do. */
export interface ReasonActionSpec {
  kind: ReasonActionKind;
  /** kind command: the JGates command line that fixes it. */
  command?: string;
  /** kind link: an official page. */
  url?: string;
  /** kind route: the UI route that offers the control. */
  route?: string;
}

export interface ReasonEntry {
  code: string;
  /** Key of the main text in the `reasons` catalogue. */
  textKey: string;
  /** Key of the action's label in the `reasons` catalogue. */
  actionLabelKey: string;
  action: ReasonActionSpec;
}

/** The action as a caller shows it: the spec plus its label in the chosen language. */
export interface ReasonAction extends ReasonActionSpec {
  label: string;
}

export interface ResolvedReason {
  code: string;
  message: string;
  action: ReasonAction;
}

const DOCKER_DESKTOP_URL = "https://www.docker.com/products/docker-desktop/";
const DOCKER_RESOURCES_URL = "https://docs.docker.com/desktop/settings-and-maintenance/settings/#resources";

const entry = (code: string, action: ReasonActionSpec): ReasonEntry => ({ code, textKey: `reason_${code}`, actionLabelKey: `reason_${code}_action`, action });

/** One entry per code. Later tasks add theirs here, with the two texts, in the same commit. */
export const REASONS: Readonly<Record<string, ReasonEntry>> = Object.freeze({
  ENGINE_NOT_INSTALLED: entry("ENGINE_NOT_INSTALLED", { kind: "link", url: DOCKER_DESKTOP_URL }),
  ENGINE_STOPPED: entry("ENGINE_STOPPED", { kind: "none" }),
  ENGINE_LOW_MEMORY: entry("ENGINE_LOW_MEMORY", { kind: "link", url: DOCKER_RESOURCES_URL }),
  DISK_LOW: entry("DISK_LOW", { kind: "route", route: "preferences/storage" }),
  IMAGE_MISSING: entry("IMAGE_MISSING", { kind: "command", command: "jgates setup" }),
  IMAGE_PULLING: entry("IMAGE_PULLING", { kind: "none" }),
  IMAGE_PULL_FAILED: entry("IMAGE_PULL_FAILED", { kind: "command", command: "jgates setup" }),
  IMAGE_VERSION_MISMATCH: entry("IMAGE_VERSION_MISMATCH", { kind: "command", command: "jgates setup" }),
  // A tool the plan needs that the tools image does not have: one shared cause, fixed by the image of this release
  // (never by a host install of the tool).
  TOOL_MISSING: entry("TOOL_MISSING", { kind: "command", command: "jgates setup" }),
  ENGINE_LOST: entry("ENGINE_LOST", { kind: "link", url: DOCKER_DESKTOP_URL }),
  DEPENDENCIES_NOT_READY: entry("DEPENDENCIES_NOT_READY", { kind: "command", command: "jgates deps status" }),
  DEPENDENCIES_FAILED: entry("DEPENDENCIES_FAILED", { kind: "command", command: "jgates deps prepare" }),
  DATA_MISSING: entry("DATA_MISSING", { kind: "command", command: "jgates tools update-data" }),
  DATA_STALE: entry("DATA_STALE", { kind: "command", command: "jgates tools update-data" }),
  // A customer-supplied tool (CodeQL) that was not prepared: the user accepts its terms and prepares it into its volume.
  CUSTOMER_SUPPLIED: entry("CUSTOMER_SUPPLIED", { kind: "command", command: "jgates tools prepare-codeql" }),
  EXTENSION_OUTDATED: entry("EXTENSION_OUTDATED", { kind: "route", route: "tools" }),
  SERVICES_NOT_READY: entry("SERVICES_NOT_READY", { kind: "route", route: "environment" }),
  SERVICES_REQUIRED: entry("SERVICES_REQUIRED", { kind: "route", route: "environment" }),
  NOT_APPLICABLE_TO_PROJECT: entry("NOT_APPLICABLE_TO_PROJECT", { kind: "route", route: "validations/review" }),
  // Developer-facing: a step that would run outside the container is a defect, with nothing to click.
  HOST_EXECUTION_REFUSED: entry("HOST_EXECUTION_REFUSED", { kind: "none" }),
  UNSUPPORTED_PLATFORM: entry("UNSUPPORTED_PLATFORM", { kind: "link", url: DOCKER_RESOURCES_URL }),
});

export function isReasonCode(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(REASONS, code);
}

/** Text and action of a code in a language (default: the process language). Throws for a code with no entry. */
export function resolveReason(code: string, params: Params = {}, locale?: string): ResolvedReason {
  const found = isReasonCode(code) ? REASONS[code] : undefined;
  if (!found) throw new Error(`no entry in the reasons catalogue for ${code}`);
  const t = translator("reasons", locale ?? getLocale());
  const { kind, command, url, route } = found.action;
  return {
    code,
    message: t(found.textKey, params),
    action: { kind, ...(command !== undefined ? { command } : {}), ...(url !== undefined ? { url } : {}), ...(route !== undefined ? { route } : {}), label: t(found.actionLabelKey, params) },
  };
}

/** "2,4 GB" / "2.4 GB" (decimal comma in Portuguese); megabytes below one GB, one decimal at most. */
export function formatBytes(bytes: number, locale?: string): string {
  const language = locale ?? getLocale();
  const gb = bytes / 1_000_000_000;
  const [value, unit] = gb >= 1 ? [gb, "GB"] : [bytes / 1_000_000, "MB"];
  const text = (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return `${language === "en" ? text : text.replace(".", ",")} ${unit}`;
}

/** Engine figures are in MiB ("4096 MB" is "4 GB" for Docker): 4 GB, 512 MB. */
export function formatMegabytes(mb: number, locale?: string): string {
  const language = locale ?? getLocale();
  const [value, unit] = mb >= 1024 ? [mb / 1024, "GB"] : [mb, "MB"];
  const text = (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");
  return `${language === "en" ? text : text.replace(".", ",")} ${unit}`;
}
