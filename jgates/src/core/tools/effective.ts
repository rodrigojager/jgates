// Effective configuration of a tool instance: the values the tool will see, each with where it comes from (a line of
// the configuration file, or the tool's own default), the flags and variables the command adds on top of the file,
// and whether the resolution is complete. A resolution that JGates cannot finish (Ruff `extend`, a JavaScript
// configuration that only the tool can evaluate) is reported as partial with the reason, never filled in by guessing.
import { openForm, type FieldView, type FormView } from "../forms/index.js";
import { openDocument } from "../documents/index.js";
import { builtinManifests } from "../../adapters/manifests.js";
import { renderExecution } from "./execution.js";
import { resolveToolBindings } from "./index.js";

export type ResolutionStatus = "complete" | "partial" | "unavailable";

export interface EffectiveValue {
  /** Path of the option in the document, as written in the file (for example tool.ruff.line-length). */
  path: string;
  label: string | null;
  value: unknown;
  origin: { kind: "file"; file: string | null; line: number | null } | { kind: "default" };
}

export interface EffectiveReason {
  code: "EXTEND_NOT_RESOLVED" | "NOT_EVALUATED" | "NO_STRUCTURED_READER" | "DOCUMENT_MISSING" | "STRUCTURED_UNAVAILABLE" | "NO_CONFIG_BINDING";
  /** Values for the message: key, line, file, format. */
  params: Record<string, string | number>;
}

export interface Prevailing {
  kind: "flag" | "env";
  name: string;
  value: string | null;
}

export interface EffectiveView {
  instance: string;
  adapter: string;
  file: string | null;
  binding: string | null;
  resolution: { status: ResolutionStatus; reasons: EffectiveReason[] };
  values: EffectiveValue[];
  /** Flags and variables of the command: they win over the same option in the file. */
  prevailing: Prevailing[];
}

function prevailingOf(dir: string, instance: string): Prevailing[] {
  let view;
  try {
    view = renderExecution(dir, instance);
  } catch {
    return [];
  }
  const out: Prevailing[] = [];
  const args = view?.command?.args ?? [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("-")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) {
      out.push({ kind: "flag", name: arg.slice(0, eq), value: arg.slice(eq + 1) });
      continue;
    }
    const next = args[i + 1];
    const takesValue = next !== undefined && !next.startsWith("-") && i + 2 <= args.length && /^--[a-z-]+$/.test(arg) && !["--no-fix", "--isolated"].includes(arg);
    out.push({ kind: "flag", name: arg, value: takesValue ? next : null });
    if (takesValue) i++;
  }
  for (const [name, value] of Object.entries(view?.command?.env ?? {})) out.push({ kind: "env", name, value });
  return out;
}

function fromForm(form: FormView, file: string | null): { values: EffectiveValue[]; reasons: EffectiveReason[] } {
  const values: EffectiveValue[] = [];
  const reasons: EffectiveReason[] = [];
  const section = form.section.join(".");
  const named = (f: FieldView) => (section ? `${section}.${f.path.join(".")}` : f.path.join("."));
  for (const f of form.fields) {
    if (f.state === "set" || f.state === "unrecognized") values.push({ path: named(f), label: f.label, value: f.value, origin: { kind: "file", file, line: f.position?.line ?? null } });
    else if (f.defaultValue !== undefined) values.push({ path: named(f), label: f.label, value: f.defaultValue, origin: { kind: "default" } });
  }
  for (const u of form.unsupported) {
    if (u.path.length === 1 && u.path[0] === "extend") {
      reasons.push({ code: "EXTEND_NOT_RESOLVED", params: { key: u.documentPath, line: u.position?.line ?? 0, file: file ?? "-" } });
    }
  }
  return { values, reasons };
}

export async function effectiveConfig(dir: string, instanceId: string, env: NodeJS.ProcessEnv = process.env): Promise<EffectiveView | null> {
  const bound = resolveToolBindings(dir).instances.find((i) => i.id === instanceId);
  if (!bound) return null;
  const primary = bound.bindings.find((b) => b.role === "primary" && b.kind === "file" && !b.refused);
  const base: EffectiveView = {
    instance: bound.id,
    adapter: bound.adapter,
    file: primary?.relPath ?? null,
    binding: primary?.id ?? null,
    resolution: { status: "complete", reasons: [] },
    values: [],
    prevailing: prevailingOf(dir, instanceId),
  };
  const partial = (status: ResolutionStatus, reason: EffectiveReason): EffectiveView => ({ ...base, resolution: { status, reasons: [reason, ...base.resolution.reasons] } });
  if (!primary) return partial("unavailable", { code: "NO_CONFIG_BINDING", params: {} });
  if (!primary.exists) return partial("unavailable", { code: "DOCUMENT_MISSING", params: { file: primary.relPath ?? primary.declared } });

  const manifest = builtinManifests().find((m) => m.id === bound.adapter);
  const hasForm = manifest?.editing.implemented.includes("structured-write") ?? false;
  if (hasForm) {
    try {
      const form = await openForm(dir, instanceId, { env });
      if (form.available) {
        const { values, reasons } = fromForm(form, base.file);
        return { ...base, values, resolution: { status: reasons.length > 0 ? "partial" : "complete", reasons } };
      }
      const code = form.unavailable?.code === "STRUCTURED_EDIT_UNAVAILABLE" ? "STRUCTURED_UNAVAILABLE" : "NO_STRUCTURED_READER";
      return partial("unavailable", { code, params: { file: base.file ?? "-", message: form.unavailable?.message ?? "" } });
    } catch (error) {
      return partial("unavailable", { code: "NO_STRUCTURED_READER", params: { file: base.file ?? "-", message: (error as Error).message } });
    }
  }
  const doc = openDocument(dir, instanceId, primary.id);
  const evaluated = doc.format === "javascript" || doc.format === "typescript";
  return partial("partial", evaluated ? { code: "NOT_EVALUATED", params: { file: base.file ?? "-", format: doc.format } } : { code: "NO_STRUCTURED_READER", params: { file: base.file ?? "-", message: "" } });
}
