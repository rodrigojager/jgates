// Insecure defaults (method `insecure-defaults`), adapted from the Trail of Bits insecure-defaults plugin (CC BY-SA 4.0,
// vendor/trailofbits-skills/insecure-defaults: adapted method.md, upstream category corpora and seed patterns unchanged).
//
//   inputs        configuration and initialization paths in the readable scope: configuration files (not JGates' own
//                 settings, not build/lint tool configuration) or code that reads environment/settings, found by the host,
//                 plus the matches of every category's seed patterns
//   hypothesis    an absent setting or a fallback (or an unconditional insecure value) leaves a protection open in a
//                 running deployment
//   method        recon   (explore, one context): stack, config wrappers that can return defaults, manifests, derived
//                         patterns per category
//                 sweep   (explore, one context): one sweep per category, configurable vs unconditional candidates
//                 verify  (validate, a fresh context per candidate, with its category's corpus): the five-step ladder
//   output        evidence/insecure-defaults/defaults.json (seed matches, recon, per-category search record with
//                 seed-only gaps, candidates with the deciding step, shape, sink and deployment answer)
//   applicability not applicable without configuration or initialization paths (INSECURE_DEFAULTS_NO_CONFIGURATION)
//   overlap       consolidated with the baseline: the Cloudflare business-logic class asks the "default and fallback
//                 behavior" question in one bullet and its wildcard class mentions hardcoded secrets; the JGates Semgrep
//                 pack flags weak hashes/ciphers, TLS verification off and CORS any-origin with credentials; the Quality
//                 secret scanners find committed credentials. This module drops weak-crypto as a category, never hunts
//                 committed secrets, and adds what those lack: the configurable/unconditional distinction, the
//                 fail-secure trace of the unconfigured state, the deployment-manifest check and a per-category corpus.
import { categoriesOf } from "../../semantic-scope/index.js";
import type { ArtifactCheck, ArtifactCheckContext, InvestigationModule, ModuleApplicability, ModuleApplicabilityInput, ModuleBriefInput, ModuleFinalizeInput, ModuleFinalizeOutput } from "../../semantic-executor/index.js";
import { briefJson, checkCandidates, checkVerdict, isCodePath, isObj, isTestPath, list, maskBrief, seenPaths, seenRef, str, strings } from "../complementary/shared.js";
import { loadInsecureCategories, loadTobMethod, tobProvenance, type InsecureCategory, type TobMethodMaterial } from "../complementary/vendor.js";

export const INSECURE_DEFAULTS_METHOD = "insecure-defaults";
export const INSECURE_DEFAULTS_MODULE_ID = "insecure-defaults";
export const DEFAULTS_FILE = "evidence/insecure-defaults/defaults.json";
export const STAGES = { recon: "recon", sweep: "sweep", verify: "verify" } as const;

const NOT_APP_CONFIG = /(^|\/)(jgates\.ya?ml|\.jgates\/.*|tsconfig[\w.-]*\.json|jsconfig\.json|\.eslintrc[\w.]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[\w.]*|prettier\.config\.[cm]?[jt]s|(vitest|jest|playwright|babel|vite|webpack|rollup)\.config\.[cm]?[jt]s|\.editorconfig|\.gitattributes|\.gitignore|\.npmrc)$/i;
const READS_CONFIG = /\bprocess\.env\b|\bos\.environ\b|\bgetenv\s*\(|\bENV(\.fetch|\[)|\bSystem\.getenv\b|\bgetProperty\s*\(|\bconfig\.get\s*\(|\bsettings\.[A-Z_]{2,}|\bget_setting\s*\(|\bLookupEnv\s*\(/;
const MANIFEST = /(^|\/)(dockerfile|docker-compose[\w.-]*\.ya?ml|compose\.ya?ml|[\w.-]+\.tf|values[\w.-]*\.ya?ml|\.env\.[\w-]+|[\w.-]*k8s[\w.-]*\.ya?ml|app\.ya?ml|fly\.toml|vercel\.json|netlify\.toml)$/i;
const MAX_MATCHES = 20;

export interface DefaultsFacts {
  configFiles: string[];
  initializationFiles: string[];
  manifests: string[];
  seedMatches: Record<string, Array<{ path: string; line: number; text: string }>>;
  droppedSeeds: Record<string, string[]>;
}

/** A matched line for a brief: quoted literals (possible credential or secret values) are replaced, the shape stays. */
const withoutLiterals = (line: string): string => line.replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '"<literal>"');

/** The host's configuration discovery and seed-pattern sweep (no model involved). */
export function defaultsFacts(input: Pick<ModuleApplicabilityInput, "readableFiles" | "readFile">, categories: readonly InsecureCategory[]): DefaultsFacts {
  const files = input.readableFiles();
  const configFiles = files.filter((p) => categoriesOf(p).includes("configuration") && !NOT_APP_CONFIG.test(p));
  const manifests = files.filter((p) => MANIFEST.test(p));
  const initializationFiles: string[] = [];
  const seedMatches: DefaultsFacts["seedMatches"] = Object.fromEntries(categories.map((c) => [c.id, []]));
  for (const p of files) {
    if (NOT_APP_CONFIG.test(p) || isTestPath(p) || (!isCodePath(p) && !configFiles.includes(p) && !manifests.includes(p))) continue;
    const text = input.readFile(p);
    if (text === null) continue;
    const lines = text.split(/\r?\n/);
    if (isCodePath(p) && lines.some((l) => READS_CONFIG.test(l))) initializationFiles.push(p);
    for (const c of categories) {
      const bucket = seedMatches[c.id] as Array<{ path: string; line: number; text: string }>;
      lines.forEach((l, k) => {
        if (bucket.length < MAX_MATCHES && c.seeds.some((re) => re.test(l))) bucket.push({ path: p, line: k + 1, text: withoutLiterals(maskBrief(l.trim().slice(0, 200))) });
      });
    }
  }
  return { configFiles, initializationFiles, manifests, seedMatches, droppedSeeds: Object.fromEntries(categories.filter((c) => c.droppedSeeds.length > 0).map((c) => [c.id, c.droppedSeeds])) };
}

const RECON_SHAPE = `{"summary": "...", "stack": ["language or framework"], "config_wrappers": [{"path": "file you read", "line": 12, "name": "get_setting", "can_default": true}], "manifests": ["deployment manifests you read"], "derived_patterns": {"<category id>": ["pattern for this stack"]}}`;
const SWEEP_SHAPE = `{"summary": "...", "categories": [{"id": "<category id>", "state": "searched|pending", "derived_patterns": ["patterns you used beyond the seeds"], "files_scanned": 12, "reason": "required when pending"}], "candidates": [{"title": "...", "path": "file you read", "line": 12, "severity": "blocking|important|suggestion|nit", "rationale": "...", "category_id": "<category id>", "shape": "configurable|unconditional", "setting": "the setting or literal's name (never its value)"}]}`;
const VERIFY_SHAPE = `{"candidateId": "C1", "confirmation": "confirmed|rejected|needs-validation", "reason": "...", "evidence": [{"path": "...", "line": 12, "note": "..."}], "severity": "optional correction", "decided_at_step": 4, "shape": "configurable|unconditional", "sink": {"path": "where the value reaches a security decision", "line": 30}, "deployment_supplies_var": "always|never|sometimes|unknown|not-applicable"}`;

function factsOf(inputs: Readonly<Record<string, unknown>> | undefined): DefaultsFacts | null {
  return (inputs?.facts as DefaultsFacts | undefined) ?? null;
}

function checkRecon(value: Record<string, unknown>, ctx: ArtifactCheckContext, ids: readonly string[]): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  const wrappers: Array<Record<string, unknown>> = [];
  for (const w of list(value.config_wrappers)) {
    if (!isObj(w)) continue;
    const at = seenRef(w.path, w.line, ctx, problems, "config wrapper");
    if (at) wrappers.push({ ...at, name: str(w.name, 80), can_default: w.can_default === true });
  }
  const derived: Record<string, string[]> = {};
  const raw = isObj(value.derived_patterns) ? value.derived_patterns : {};
  for (const id of ids) derived[id] = strings(raw[id], 200, 12);
  const manifests = seenPaths(value.manifests, ctx, problems, "manifest");
  return { ok: true, problems, value: { summary, stack: strings(value.stack, 80, 12), config_wrappers: wrappers, manifests, derived_patterns: derived }, examined: [...new Set([...wrappers.map((w) => w.path as string), ...manifests])] };
}

function checkSweep(value: Record<string, unknown>, ctx: ArtifactCheckContext, ids: readonly string[]): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  const gaps: Array<{ path?: string; reason: string }> = [];
  const recon = ctx.accepted?.[STAGES.recon] as { derived_patterns?: Record<string, string[]> } | undefined;
  const categories: Array<Record<string, unknown>> = [];
  for (const c of list(value.categories)) {
    if (!isObj(c) || !ids.includes(String(c.id)) || categories.some((x) => x.id === c.id)) continue;
    const derivedPatterns = [...new Set([...strings(c.derived_patterns, 200, 12), ...(recon?.derived_patterns?.[String(c.id)] ?? [])])];
    let state = c.state === "searched" ? "searched" : "pending";
    const reason = str(c.reason, 400);
    if (state === "pending") gaps.push({ reason: `category ${String(c.id)} pending: ${reason || "no reason given"}` });
    else if (derivedPatterns.length === 0) gaps.push({ reason: `category ${String(c.id)} ran only the generic seed patterns (no pattern derived for this stack)` });
    if (state === "searched" && typeof c.files_scanned === "number" && c.files_scanned === 0) {
      state = "pending";
      gaps.push({ reason: `category ${String(c.id)} scanned no file` });
    }
    categories.push({ id: c.id, state, derived_patterns: derivedPatterns, files_scanned: typeof c.files_scanned === "number" ? c.files_scanned : null, ...(state === "pending" ? { reason: reason || "no reason given" } : {}) });
  }
  for (const id of ids) if (!categories.some((c) => c.id === id)) gaps.push({ reason: `category ${id} was not reported by the sweep` });
  const candidates = checkCandidates(value.candidates, ctx, problems, "insecure-default", (c, at) => {
    const id = String(c.category_id ?? "");
    if (!ids.includes(id)) {
      problems.push(`the candidate at ${at.path} is dropped: ${JSON.stringify(id.slice(0, 40))} is not a category of this method`);
      return null;
    }
    const shape = c.shape === "unconditional" ? "unconditional" : "configurable";
    return { category_id: id, shape, setting: str(c.setting, 120) };
  });
  return { ok: true, problems, value: { summary, categories }, candidates, examined: [...new Set(candidates.map((c) => c.path))], gaps };
}

function checkVerify(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  return checkVerdict(value, ctx, (problems) => {
    const step = typeof value.decided_at_step === "number" && value.decided_at_step >= 1 && value.decided_at_step <= 5 ? Math.floor(value.decided_at_step) : null;
    const shape = value.shape === "unconditional" ? "unconditional" : value.shape === "configurable" ? "configurable" : null;
    const sink = isObj(value.sink) ? seenRef(value.sink.path, value.sink.line, ctx, problems, "sink") : null;
    if (value.confirmation === "confirmed" && !sink) problems.push("a confirmed insecure default needs the sink where it reaches a security decision (step 4), in a file this context read");
    const supplies = ["always", "never", "sometimes", "unknown", "not-applicable"].includes(String(value.deployment_supplies_var)) ? String(value.deployment_supplies_var) : null;
    if (shape === "unconditional" && value.confirmation === "rejected" && step === 2) problems.push("step 2 cannot refute an unconditional candidate");
    return { decided_at_step: step, shape, sink, deployment_supplies_var: supplies };
  });
}

function brief(input: ModuleBriefInput, categories: readonly InsecureCategory[]): string | null {
  const facts = factsOf(input.inputs);
  const catList = categories.map((c) => `- ${c.id} (${c.title}). Report when: ${c.reportWhen} Skip when: ${c.skipWhen}`).join("\n");
  if (input.stage.id === STAGES.recon) {
    return [`Categories:\n${catList}`, briefJson("Host discovery (configuration files, files that read configuration, deployment manifests, seed-pattern matches per category):", facts)].join("\n");
  }
  if (input.stage.id === STAGES.sweep) {
    const recon = input.accepted[STAGES.recon];
    return [`Categories:\n${catList}`, briefJson("Seed-pattern matches (a floor, not the search):", facts?.seedMatches ?? {}), recon ? briefJson("Reconnaissance (host-validated):", recon) : "There is no accepted reconnaissance: derive the patterns yourself."].join("\n");
  }
  if (input.stage.id === STAGES.verify && input.candidate) {
    const id = (input.candidate.details as { category_id?: string } | undefined)?.category_id;
    const cat = categories.find((c) => c.id === id);
    return [cat ? `Corpus of the category ${cat.id} (Trail of Bits, CC BY-SA 4.0, unchanged):\n<corpus category="${cat.id}" trust="method-material">\n${cat.corpus}\n</corpus>` : "The candidate names no known category.", briefJson("Deployment manifests in scope:", facts?.manifests ?? [])].join("\n");
  }
  return null;
}

function finalize(input: ModuleFinalizeInput): ModuleFinalizeOutput {
  const sweep = input.accepted[STAGES.sweep] as { categories?: Array<Record<string, unknown>> } | undefined;
  const doc = {
    schemaVersion: 1,
    kind: "semantic-insecure-defaults",
    method: INSECURE_DEFAULTS_METHOD,
    generatedAt: input.now.toISOString(),
    discovery: factsOf(input.inputs),
    recon: input.accepted[STAGES.recon] ?? null,
    categories: sweep?.categories ?? [],
    candidates: input.candidates.map((c) => ({ id: c.id, title: c.title, path: c.path, line: c.line, severity: c.severity, status: c.status, details: c.details ?? null, validation: c.validation })),
  };
  const pending = (sweep?.categories ?? []).filter((c) => c.state === "pending");
  return {
    files: [{ path: DEFAULTS_FILE, content: `${JSON.stringify(doc, null, 2)}\n` }],
    gaps: pending.map((c) => ({ code: "CATEGORY_PENDING", reason: `${String(c.id)}: ${String(c.reason ?? "pending")}` })),
    report: { categories: (sweep?.categories ?? []).length, pending: pending.length, candidates: input.candidates.length, confirmed: input.candidates.filter((c) => c.status === "confirmed").length },
  };
}

export function insecureDefaultsModule(options: { material?: TobMethodMaterial } = {}): InvestigationModule {
  const material = options.material ?? loadTobMethod("insecure-defaults", ["recon", "sweep", "verify"]);
  const { categories, sha256 } = loadInsecureCategories();
  const ids = categories.map((c) => c.id);
  const b = material.blocks;
  return {
    id: INSECURE_DEFAULTS_MODULE_ID,
    version: "1",
    title: "Insecure defaults",
    objective: b.objective as string,
    provenance: tobProvenance("insecure-defaults", material.sha256, { categories: ids, corporaSha256: sha256, consolidated: ["weak-crypto (Semgrep pack and Cloudflare cryptography class)", "committed credentials (Quality secret scanners)"] }),
    minimum: { exploreCalls: 2, reserveCalls: 1 },
    applicability: (input): ModuleApplicability => {
      const facts = defaultsFacts(input, categories);
      if (facts.configFiles.length === 0 && facts.initializationFiles.length === 0 && facts.manifests.length === 0) {
        return { applicable: false, code: "INSECURE_DEFAULTS_NO_CONFIGURATION", missing: "configuration files", reason: "insecure-defaults review needs configuration or initialization paths: the readable scope has no application configuration file, no deployment manifest and no code that reads environment or settings (JGates' own settings and build or lint tool configuration do not count)" };
      }
      return { applicable: true, inputs: { facts }, record: { configFiles: facts.configFiles.length, initializationFiles: facts.initializationFiles.length, manifests: facts.manifests.length, seedMatches: Object.fromEntries(Object.entries(facts.seedMatches).map(([k, v]) => [k, v.length])) } };
    },
    stages: [
      { id: STAGES.recon, label: "Configuration reconnaissance", role: "explore", required: true, contexts: "once", instructions: b.recon as string, artifact: { kind: "custom", shape: RECON_SHAPE, validate: (v, ctx) => checkRecon(v, ctx, ids) } },
      { id: STAGES.sweep, label: "Category sweeps", role: "explore", required: true, contexts: "once", instructions: b.sweep as string, artifact: { kind: "custom", shape: SWEEP_SHAPE, validate: (v, ctx) => checkSweep(v, ctx, ids) } },
      { id: STAGES.verify, label: "Refuting verification", role: "validate", required: true, contexts: "per-candidate", instructions: b.verify as string, artifact: { kind: "custom", shape: VERIFY_SHAPE, validate: checkVerify } },
    ],
    brief: (input) => brief(input, categories),
    finalize,
  };
}
