import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { translator, type Translator } from "../../i18n/index.js";
import { readVersion } from "../../cli/version.js";
import { listBuiltinProfiles, listBuiltinTemplates, getBuiltinTemplate, isBuiltinRef } from "../../builtin/index.js";
import { qualityBridgeManifest } from "../../adapters/quality-bridge/manifest.js";
import { buildRequest } from "../../adapters/quality-bridge/index.js";
import { bridgeToolConfigs, effectiveCommand, isConfigurable } from "../../adapters/quality-bridge/tool-configs.js";
import { ADAPTER_ID, planSubchecks, type BridgeSelection, type SubcheckPlan } from "../../adapters/quality-bridge/requirements.js";
import { duplicateLinters, duplicateScanners, supersededPairs } from "../../adapters/quality-bridge/superseded.js";
import { resolvePython, resolveSidecarDir } from "../bridge/index.js";
import { loadProjectConfig, parseYamlFile } from "../config/load/index.js";
import { discoverFor, encodePointer, resolveConfig, type CallOverride, type ResolvedField, type ResolveResult } from "../config/resolve/index.js";
import { ARCHITECTURE_FILE, readArchitecture } from "../architecture/index.js";
import type { Classification, Inventory } from "../discovery/types.js";
import { contentHash, workspaceId } from "../ids/index.js";
import { resolveHome } from "../home/index.js";
import { gitContext, materializeCommit, removeSnapshot, resolveCommit, snapshotsDir, SnapshotError } from "../snapshot/index.js";
import {
  resolveSelection,
  skipOverrides,
  type LockInfo,
  type PairState,
  type SelectionDecision,
  type SelectionIssue,
  type SelectionItem,
  type SelectionResult,
  type UniverseTool,
} from "../selection/index.js";
import { externalAdapter, type ExternalAdapter, type ExternalPlan } from "./adapters.js";
import { entityStates } from "../../adapters/builtin-pii/settings.js";
import { invalidToolConfigs } from "./config-validity.js";
import { governExternalPlan } from "../governed/plan.js";
import { diffPlans } from "./diff.js";
import { readLastPlan } from "./store.js";
import {
  PLAN_KIND,
  PLAN_SCOPES,
  PLAN_SCHEMA_VERSION,
  type BuildPlanOptions,
  type BuildPlanResult,
  type Inclusion,
  type Plan,
  type PlanBlocker,
  type PlanBody,
  type PlanArchitecture,
  type PlanCommand,
  type PlanComponentRef,
  type PlanError,
  type PlanItem,
  type PlanOrigin,
  type PlanRequest,
  type PlanRequirement,
  type PlanScopeKind,
  type SelectionOverride,
  type StateOrigin,
  type TemplateIncompatibility,
  type UncoveredRequirement,
} from "./types.js";

/** Placeholder of the run folder in commands: the runner creates it outside the workspace. */
export const RUN_DIR_TOKEN = "{runDir}";
const BRIDGE_ARGS = ["-m", "quality_sidecar", "bridge"];
const DEFAULT_TIMEOUT_SECONDS = 30 * 60;
/** Bridge subchecks that need mode full (external tools). */
const FULL_ONLY = ["megalinter", "semgrep", "trivy", "osv-scanner", "jscpd", "checkov", "gitleaks"];

const sha256 = (bytes: Buffer): string => "sha256:" + crypto.createHash("sha256").update(bytes).digest("hex");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const uniqueSorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

/** Body of the plan without the fields outside the hash. */
export function planBody(plan: Plan | PlanBody): PlanBody {
  const { planHash: _h, createdAt: _c, changes: _d, ...body } = plan as Plan;
  return body as PlanBody;
}

/** Hash of the plan: content hash of everything except planHash, createdAt and changes. */
export function computePlanHash(plan: Plan | PlanBody): string {
  return contentHash(planBody(plan));
}

/** Normalizes the request of a plan (defaults, order kept: flags are applied in the order given). */
export function normalizeRequest(options: BuildPlanOptions): PlanRequest {
  const split = (values: readonly string[] | undefined): string[] =>
    (values ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()).filter((s) => s !== "");
  return {
    profile: options.profile ?? null,
    scope: options.scope ?? "full",
    paths: [...(options.paths ?? [])],
    base: options.base ?? null,
    head: options.head ?? null,
    skip: [...new Set(split(options.skip))],
    only: [...new Set(split(options.only))],
    templates: [...new Set(options.templates ?? [])],
  };
}

function checkRequest(request: PlanRequest, t: Translator): PlanError | null {
  if (!PLAN_SCOPES.includes(request.scope)) {
    return { code: "BAD_SCOPE", message: t("plan_bad_scope", { value: String(request.scope), allowed: PLAN_SCOPES.join(", ") }), fix: t("plan_bad_scope_fix", { allowed: PLAN_SCOPES.join(", ") }) };
  }
  if (request.scope === "paths" && request.paths.length === 0) return { code: "PATHS_REQUIRED", message: t("plan_paths_required"), fix: t("plan_paths_required_fix") };
  if (request.scope !== "paths" && request.paths.length > 0) return { code: "PATHS_NOT_ALLOWED", message: t("plan_paths_not_allowed", { scope: request.scope }), fix: t("plan_paths_not_allowed_fix") };
  // --head names the commit to analyze (in a snapshot), with any scope; --base only bounds a changed scope.
  if (request.scope !== "changed" && request.base !== null) {
    return { code: "REFS_NOT_ALLOWED", message: t("plan_refs_not_allowed", { scope: request.scope }), fix: t("plan_refs_not_allowed_fix") };
  }
  return null;
}

/** The python and sidecar the bridge would use, found without starting anything. */
function bridgeRuntime(env: NodeJS.ProcessEnv): { interpreter: string | null; logical: string; sidecarDir: string | null; toolVersion: string | null } {
  const { interpreter } = resolvePython(env);
  const sidecarDir = resolveSidecarDir(env);
  let toolVersion: string | null = null;
  if (sidecarDir) {
    try {
      const text = fs.readFileSync(path.join(path.dirname(sidecarDir), "pyproject.toml"), "utf8");
      toolVersion = /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? null;
    } catch {
      toolVersion = null;
    }
  }
  return { interpreter, logical: env.JGATES_PYTHON ?? "python", sidecarDir, toolVersion };
}

/** Hashes of the configuration files of the plan, relative to the configuration folder `dir`. */
function fileHashes(dir: string, effective: ResolveResult): Map<string, string | null> {
  const files = new Set<string>();
  for (const d of loadProjectConfig(dir).documents) files.add(d.file);
  for (const n of effective.templates.nodes) files.add(n.file);
  for (const link of effective.profile?.chain ?? []) files.add(link.file);
  for (const f of Object.values(effective.fields)) if (f.file) files.add(f.file);
  const builtins = new Map<string, unknown>();
  for (const item of [...listBuiltinTemplates(), ...listBuiltinProfiles()]) builtins.set(item.file, item.value);
  const out = new Map<string, string | null>();
  for (const file of [...files].sort()) {
    if (file.startsWith("builtin:")) out.set(file, builtins.has(file) ? contentHash(builtins.get(file)) : null);
    else {
      try {
        out.set(file, sha256(fs.readFileSync(path.join(dir, file))));
      } catch {
        out.set(file, null);
      }
    }
  }
  return out;
}

interface TemplateMatch {
  languages: string[];
  frameworks: string[];
}

/** Support declared by a built-in template (level and what it does not cover), or nothing. */
function supportOf(source: string): { support?: { level: string; uncovered: string[] } } {
  const declared = isBuiltinRef(source) ? getBuiltinTemplate(source)?.value.support : undefined;
  if (!isPlainObject(declared) || typeof declared.level !== "string") return {};
  return { support: { level: declared.level, uncovered: stringList(declared.uncovered) } };
}

function templateMatch(dir: string, effective: ResolveResult, entryId: string, source: string, identity: string): TemplateMatch | null {
  const entries = isPlainObject(effective.config.templates) ? effective.config.templates : {};
  const entry = isPlainObject(entries[entryId]) ? (entries[entryId] as Record<string, unknown>) : {};
  let match: unknown = entry.match;
  if (match === undefined) {
    if (isBuiltinRef(source)) match = getBuiltinTemplate(source)?.value.match;
    else {
      const node = effective.templates.nodes.find((n) => n.ref === identity);
      if (node) {
        const parsed = parseYamlFile(path.join(dir, node.file), node.file);
        match = isPlainObject(parsed.value) ? parsed.value.match : undefined;
      }
    }
  }
  if (!isPlainObject(match)) return null;
  const languages = stringList(match.languages);
  const frameworks = stringList(match.frameworks);
  return languages.length === 0 && frameworks.length === 0 ? null : { languages, frameworks };
}

function fits(c: Classification, m: TemplateMatch): boolean {
  return (m.languages.length === 0 || (c.language !== null && m.languages.includes(c.language))) && (m.frameworks.length === 0 || (c.framework !== null && m.frameworks.includes(c.framework)));
}

function originOf(decision: SelectionDecision | null, reason: string): PlanOrigin {
  if (!decision) return { kind: "none", selector: null, layer: null, source: null, file: null, path: null, pointer: null };
  return {
    kind: stateOrigin(decision, reason) ?? "none",
    selector: decision.selector,
    layer: decision.layer,
    source: decision.source,
    file: decision.file,
    path: decision.path,
    pointer: decision.pointer === "" ? null : decision.pointer,
  };
}

function stateOrigin(decision: SelectionDecision | null, reason: string): StateOrigin | null {
  if (!decision) return null;
  if (reason === "LOCKED_REQUIRED") return "policy";
  return decision.layer === "call" ? "run" : decision.layer;
}

const where = (d: SelectionDecision | null): string => (d ? (d.file ? `${d.file}${d.path ? `#${d.path}` : ""}` : d.source) : "-");

/** Selectors that reach one item: the instance, its composite parent, its capabilities and their categories, its component. */
export function coverSelectors(item: Pick<PlanItem, "tool" | "capabilities" | "category" | "components" | "granularity">, parent: string | null): string[] {
  const out = [`tool:${item.tool}`];
  if (parent) out.push(`tool:${parent}`);
  for (const c of item.capabilities) out.push(`capability:${c}`);
  if (item.category) out.push(`category:${item.category}`);
  if (item.granularity === "component") for (const c of item.components) out.push(`component:${c.id}`);
  return out;
}

/**
 * Deduplicates items by semantic identity (what runs and how), never by tool name: the first one stays and
 * collects the inclusions and components of the others. Two instances of one tool on different components have
 * different identities and both stay.
 */
export function dedupeItems(items: PlanItem[]): PlanItem[] {
  const byIdentity = new Map<string, PlanItem>();
  for (const item of items) {
    const kept = byIdentity.get(item.identity);
    if (!kept) {
      byIdentity.set(item.identity, { ...item, includedBy: [...item.includedBy], components: [...item.components] });
      continue;
    }
    for (const inc of item.includedBy) {
      if (!kept.includedBy.some((k) => k.kind === inc.kind && k.entry === inc.entry && k.source === inc.source)) kept.includedBy.push(inc);
    }
    for (const c of item.components) if (!kept.components.some((k) => k.id === c.id)) kept.components.push(c);
    kept.configFiles = [...new Map([...kept.configFiles, ...item.configFiles].map((f) => [f.file, f])).values()].sort((a, b) => a.file.localeCompare(b.file));
  }
  return [...byIdentity.values()];
}

interface PairEval {
  tool: UniverseTool;
  capability: string;
  base: PairState | undefined;
  eff: PairState;
  onlyExcluded: boolean;
}

function selectionError(issues: SelectionIssue[]): BuildPlanResult {
  const first = issues[0] as SelectionIssue;
  return { ok: false, error: { code: first.code, message: first.message, fix: first.fix ?? null }, errors: issues, diagnostics: [] };
}

function resolveError(result: ResolveResult, t: Translator): BuildPlanResult {
  const first = result.errors[0];
  const error: PlanError = first
    ? { code: first.code, message: first.message, fix: first.fix ?? null }
    : { code: "RESOLVE_FAILED", message: t("plan_resolve_failed"), fix: null };
  return { ok: false, error, errors: result.errors.map((e) => ({ code: e.code, message: e.message, fix: e.fix ?? null })), diagnostics: result.diagnostics };
}

/** The architecture rules with their state: `enabled: false` in architecture.yml shows as disabled, with the place. */
function architectureOf(dir: string): PlanArchitecture | null {
  const { declaration } = readArchitecture(dir);
  if (!declaration) return null;
  return {
    file: ARCHITECTURE_FILE,
    rules: (declaration.contract.rules ?? []).map((rule, index) => ({
      id: rule.id,
      kind: rule.kind,
      enabled: rule.enabled !== false,
      blocking: rule.blocking !== false,
      owner: rule.owner ?? "source",
      origin: { file: ARCHITECTURE_FILE, path: `architecture.rules[${index}].enabled` },
    })),
  };
}

/**
 * Builds the plan of a workspace. Reads the configuration, the discovery and the selection; installs nothing,
 * runs nothing and writes nothing (the CLI saves the plan in the data folder afterwards). Never throws for
 * configuration problems: they come back as an error result.
 */
export function buildPlan(projectDir: string, options: BuildPlanOptions = {}): BuildPlanResult {
  const t = translator("plan");
  const workspace = path.resolve(projectDir);
  const env = options.env ?? process.env;
  const request = normalizeRequest(options);
  const fail = (error: PlanError): BuildPlanResult => ({ ok: false, error, errors: [error], diagnostics: [] });
  const problem = checkRequest(request, t);
  if (problem) return fail(problem);
  if (request.base === null && request.head === null) return buildPlanFrom(workspace, workspace, options, request, { base: null, head: null });

  // Git references are resolved to full commit ids now: the plan records what they named when it was made.
  const git = gitContext(workspace, env);
  if (!git.repository) {
    const code = git.available ? "NOT_A_GIT_REPOSITORY" : "GIT_UNAVAILABLE";
    return fail({ code, message: t(`plan_${code.toLowerCase()}`), fix: t(`plan_${code.toLowerCase()}_fix`) });
  }
  const resolve = (ref: string | null): string | null | PlanError => {
    if (ref === null) return null;
    return resolveCommit(git, workspace, ref, env) ?? { code: "REF_UNKNOWN", message: t("plan_ref_unknown", { ref }), fix: t("plan_ref_unknown_fix") };
  };
  const base = resolve(request.base);
  if (base !== null && typeof base === "object") return fail(base);
  const head = resolve(request.head);
  if (head !== null && typeof head === "object") return fail(head);
  if (head === null) return buildPlanFrom(workspace, workspace, options, request, { base, head: null });

  // Another commit: its configuration is read from a snapshot in the data folder, never by a checkout in the user's
  // work tree. The planning snapshot is removed right after; the run writes its own one.
  const home = options.home ?? resolveHome({ env });
  const dest = path.join(snapshotsDir(home, workspaceId(workspace)), `plan-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    materializeCommit(git, head, dest, env);
  } catch (error) {
    if (!(error instanceof SnapshotError)) throw error;
    return fail({ code: error.code, message: t("plan_snapshot_failed", { commit: head, detail: error.message }), fix: t("plan_snapshot_failed_fix") });
  }
  try {
    return buildPlanFrom(dest, workspace, options, request, { base, head });
  } finally {
    removeSnapshot(dest);
  }
}

/**
 * Builds the plan from the files of `source` (the workspace, or the snapshot of the commit asked with --head) for the
 * workspace `workspaceDir`, which gives the plan its identity, its bridge target and its previous plan.
 */
function buildPlanFrom(source: string, workspaceDir: string, options: BuildPlanOptions, request: PlanRequest, refs: { base: string | null; head: string | null }): BuildPlanResult {
  const t = translator("plan");
  const dir = source;
  const env = options.env ?? process.env;
  // The configuration folder: the analyzed files themselves, or an external policy that replaces their configuration.
  const configDir = options.configDir === undefined ? dir : path.resolve(options.configDir);

  const inventory: Inventory = discoverFor(dir, configDir);
  const common = {
    inventory,
    ...(configDir !== dir ? { configDir } : {}),
    ...(request.profile !== null ? { profile: request.profile } : {}),
    ...(request.templates.length > 0 ? { templates: request.templates } : {}),
  };
  const baseline = resolveConfig(dir, common);
  if (!baseline.ok) return resolveError(baseline, t);
  const overrides: CallOverride[] = [
    ...request.only.map((selector) => ({ pointer: encodePointer(["checks", selector, "enabled"]), value: true, source: "--only" })),
    ...skipOverrides(request.skip),
  ];
  const effective = overrides.length > 0 ? resolveConfig(dir, { ...common, overrides }) : baseline;
  if (!effective.ok) return resolveError(effective, t);

  const selEff = resolveSelection(effective, { inventory });
  if (!selEff.ok) return selectionError(selEff.errors);
  const selBase = overrides.length > 0 ? resolveSelection(baseline, { inventory }) : selEff;
  if (!selBase.ok) return selectionError(selBase.errors);

  const universe = selEff.universe;
  const capCategory = new Map(universe.capabilities.map((c) => [c.id, c.category]));
  const toolItem = (sel: SelectionResult, id: string): SelectionItem | undefined => sel.items.find((i) => i.kind === "tool" && i.id === id);
  const manifestIds = new Set([qualityBridgeManifest.id]);
  const subchecks = new Map((qualityBridgeManifest.subchecks ?? []).map((s) => [s.id, s]));

  // 1. Every runnable pair (tool instance x capability), with this run's --only filter.
  const pairs: PairEval[] = [];
  const onlyLockErrors: SelectionIssue[] = [];
  for (const tool of universe.tools) {
    if (manifestIds.has(tool.id)) continue; // the composite stands for its subchecks
    const effItem = toolItem(selEff, tool.id);
    const baseItem = toolItem(selBase, tool.id);
    for (const pair of effItem?.capabilities ?? []) {
      const capability = pair.capability ?? "";
      const covers = [`tool:${tool.id}`, ...(tool.parent ? [`tool:${tool.parent}`] : []), `capability:${capability}`];
      const cat = capCategory.get(capability);
      if (cat) covers.push(`category:${cat}`);
      if (tool.component) covers.push(`component:${tool.component}`);
      const onlyExcluded = request.only.length > 0 && pair.enabled && !covers.some((c) => request.only.includes(c));
      if (onlyExcluded && (pair.locked?.length ?? 0) > 0) {
        const lock = (pair.locked as LockInfo[])[0] as LockInfo;
        onlyLockErrors.push({
          code: "LOCKED_REQUIREMENT",
          selector: lock.selector,
          message: t("plan_only_locked", { item: `${tool.id}#${capability}`, lock: lock.selector, reason: lock.reason }),
          fix: t("plan_only_locked_fix", { lock: lock.selector }),
          file: lock.file,
          path: lock.path,
          lock,
          items: [`tool:${tool.id}`],
        });
      }
      pairs.push({ tool, capability, base: baseItem?.capabilities?.find((p) => p.capability === pair.capability), eff: pair, onlyExcluded });
    }
  }
  if (onlyLockErrors.length > 0) return selectionError(onlyLockErrors);

  const selectedPair = (p: PairEval): boolean => p.eff.enabled && !p.onlyExcluded;
  const bridgePairs = pairs.filter((p) => p.tool.parent === ADAPTER_ID);
  const subOf = (p: PairEval): string => p.tool.id.slice(ADAPTER_ID.length + 1);
  // A bridge subcheck whose tool an individual adapter runs for the same capability is left out (the same
  // tool never runs twice); the item says which one replaces it.
  const configuredTools = isPlainObject(effective.config.tools) ? effective.config.tools : {};
  const adapterOfTool = (id: string): string | null => {
    const body = configuredTools[id];
    return isPlainObject(body) && typeof body.adapter === "string" ? body.adapter : null;
  };
  const superseded = supersededPairs(
    bridgePairs.filter(selectedPair).map((p) => ({ subcheck: subOf(p), capability: p.capability })),
    pairs.filter((p) => p.tool.parent === null && selectedPair(p)).map((p) => ({ tool: p.tool.id, adapter: adapterOfTool(p.tool.id), capability: p.capability })),
  );
  const supersededOf = (p: PairEval) => (p.tool.parent === ADAPTER_ID ? superseded.get(`${subOf(p)}#${p.capability}`) : undefined);
  const isOn = (p: PairEval): boolean => selectedPair(p) && supersededOf(p) === undefined;
  const subOn = (sub: string, cap?: string): boolean => bridgePairs.some((p) => p.tool.id === `${ADAPTER_ID}.${sub}` && (cap === undefined || p.capability === cap) && isOn(p));

  // 2. The bridge request this selection needs, and what the bridge process runs with it.
  const selection: BridgeSelection = {
    mode: "quick",
    pii: false,
    secrets: subOn("gitleaks"),
    iac: subOn("checkov") || subOn("trivy", "iac"),
    projectTests: subOn("project-tests"),
    coverage: subOn("coverage"),
  };
  // A governed run always asks for the complete mode (the subchecks list still says what runs).
  selection.mode = options.bridgePolicy || FULL_ONLY.some((s) => subOn(s)) ? "full" : "quick";
  const anyBridge = bridgePairs.some(isOn);
  // The request names the subchecks to run, so a subcheck the plan turned off is not run by the bridge at all.
  const requestedSubs = [...subchecks.keys()].filter((s) => subOn(s));
  selection.subchecks = requestedSubs;
  // Project configuration files of the scanners that will run (local mode only: with an external configuration
  // folder the analyzed files never choose the scanners' configuration, so the packaged ones are used).
  const bridgeConfigs = bridgeToolConfigs(dir, anyBridge && configDir === dir ? requestedSubs : []);
  if (Object.keys(bridgeConfigs.toolConfigs).length > 0) selection.toolConfigs = { ...bridgeConfigs.toolConfigs };
  const subPlans = new Map<string, SubcheckPlan>(planSubchecks(selection, [...subchecks.keys()]).map((p) => [p.subcheckId, p]));
  const runtime = bridgeRuntime(env);
  const command: PlanCommand | null = anyBridge
    ? {
        invocation: ADAPTER_ID,
        executable: runtime.interpreter ?? runtime.logical,
        args: [...BRIDGE_ARGS],
        cwd: RUN_DIR_TOKEN,
        env: runtime.sidecarDir ? { PYTHONPATH: runtime.sidecarDir } : {},
        stdin: {
          ...buildRequest(selection, workspaceDir, `${RUN_DIR_TOKEN}/outputs/${ADAPTER_ID}`),
          // The governed request: the policy's quality policy, and the closed, forced list of MegaLinter's linters.
          ...(options.bridgePolicy ? { policyFile: options.bridgePolicy.file, policySha256: options.bridgePolicy.sha256, requirePolicy: true, hardened: true } : {}),
        },
      }
    : null;
  const invoked = new Set(anyBridge ? [...subPlans.values()].filter((p) => p.required).map((p) => p.subcheckId) : []);

  // 3. Components and the templates that apply to each.
  const approvable = inventory.classifications.filter((c) => c.approvable);
  const matches = new Map<string, TemplateMatch | null>();
  for (const a of effective.templates.active) matches.set(a.id, templateMatch(configDir, effective, a.id, a.source, a.chain[a.chain.length - 1] ?? a.source));
  const componentTemplates = (c: Classification): string[] =>
    effective.templates.active.filter((a) => {
      const m = matches.get(a.id);
      return m === null || m === undefined ? true : fits(c, m);
    }).map((a) => a.id);
  const components = inventory.classifications.map((c) => ({
    id: c.id,
    root: c.componentRoot,
    language: c.language,
    framework: c.framework,
    status: c.classificationStatus,
    approvable: c.approvable,
    templates: c.approvable ? componentTemplates(c) : [],
  }));
  const componentRefs: PlanComponentRef[] = approvable.map((c) => ({ id: c.id, root: c.componentRoot, language: c.language }));

  // 4. Inputs.
  const hashes = fileHashes(configDir, effective);
  for (const f of bridgeConfigs.files) hashes.set(f.file, f.sha256);
  const fileRef = (file: string): { file: string; sha256: string | null } => ({ file, sha256: hashes.get(file) ?? null });
  const config = effective.config;
  const execution = isPlainObject(config.execution) ? config.execution : {};
  const timeoutSeconds = typeof execution.timeoutSeconds === "number" ? execution.timeoutSeconds : DEFAULT_TIMEOUT_SECONDS;
  const networkPolicy = typeof execution.network === "string" ? execution.network : "explicit";

  // Tool instances of the adapters that run their own process (not the composite bridge): planned before the items.
  const toolsConfig = isPlainObject(config.tools) ? config.tools : {};
  const externals = new Map<string, { adapter: ExternalAdapter; plan: ExternalPlan }>();
  for (const tool of universe.tools) {
    if (tool.parent) continue;
    const body = toolsConfig[tool.id];
    const adapter = externalAdapter(isPlainObject(body) && typeof body.adapter === "string" ? body.adapter : null);
    const first = pairs.find((p) => p.tool.id === tool.id);
    if (!adapter || !first) continue;
    const componentRoot = tool.component ? (inventory.classifications.find((c) => c.id === tool.component)?.componentRoot ?? null) : null;
    // Beyond the common input, adapters that read the resolved configuration get it with its selection.
    const planInput = {
      dir,
      env,
      tool: tool.id,
      capability: first.capability,
      componentRoot,
      timeoutSeconds,
      config: effective.config,
      selection: selEff,
      ...(configDir !== dir ? { policyDir: configDir } : {}),
    };
    // Under a CI policy the trust table of the governed path decides what an adapter may do (core/governed).
    const planned = configDir !== dir ? governExternalPlan(adapter.manifest.id, tool.id, adapter.plan(planInput)) : adapter.plan(planInput);
    externals.set(tool.id, { adapter, plan: planned });
    for (const f of planned.configFiles) hashes.set(f.file, f.sha256);
  }

  const inclusionOf = (toolId: string): Inclusion[] => {
    const field: ResolvedField | undefined =
      effective.fields[encodePointer(["tools", toolId, "adapter"])] ??
      Object.values(effective.fields).find((f) => f.pointer.startsWith(`${encodePointer(["tools", toolId])}/`));
    if (!field) return [{ kind: "adapter", entry: null, source: `adapter:${toolId}`, file: null, reason: null, matched: [] }];
    if (field.layer === "template") {
      const entries = effective.templates.active.filter((a) => a.chain.includes(field.source));
      if (entries.length > 0) {
        return entries.map((a) => ({ kind: "template" as const, entry: a.id, source: field.source, file: field.file, reason: a.reason, matched: [...(a.matched ?? [])] }));
      }
    }
    return [{ kind: field.layer === "template" ? "template" : field.layer === "defaults" ? "adapter" : "project", entry: null, source: field.source, file: field.file, reason: null, matched: [] }];
  };

  // 5. Items.
  const items: PlanItem[] = [];
  /** Items whose capability claim has no verifiable contract: they run, but never cover a capability or a category. */
  const uncredited = new Map<string, string>();
  for (const p of pairs) {
    const bridge = p.tool.parent === ADAPTER_ID;
    const subId = bridge ? p.tool.id.slice(ADAPTER_ID.length + 1) : null;
    const sub = subId ? subchecks.get(subId) : undefined;
    const subPlan = subId ? subPlans.get(subId) : undefined;
    const on = isOn(p);
    const onlyDecision: SelectionDecision = { selector: "--only", value: false, layer: "call", source: "--only", file: null, path: null, pointer: "", specificity: 0 };
    const decision = p.onlyExcluded ? onlyDecision : p.eff.decision;
    const reason = p.onlyExcluded ? "ONLY_EXCLUDED" : p.eff.reason;
    const origin = stateOrigin(decision, reason);
    const ext = externals.get(p.tool.id);
    const executable = bridge || ext !== undefined;
    const adapterId = bridge ? ADAPTER_ID : (ext?.adapter.manifest.id ?? null);
    const id = `${p.tool.id}#${p.capability}`;
    let reasonCode: string;
    let reasonMessage: string;
    if (on && !executable) {
      reasonCode = "NO_EXECUTABLE_ADAPTER";
      reasonMessage = t("plan_reason_no_adapter", { tool: p.tool.id, where: where(decision) });
    } else if (supersededOf(p)) {
      const replaced = supersededOf(p)!;
      reasonCode = replaced.reason.code;
      reasonMessage = replaced.reason.message;
    } else if (on) {
      reasonCode = reason === "LOCKED_REQUIRED" ? "LOCKED" : "SELECTED";
      reasonMessage = t(reason === "LOCKED_REQUIRED" ? "plan_reason_locked" : "plan_reason_selected", { selector: decision?.selector ?? "-", where: where(decision) });
    } else if (reason === "ONLY_EXCLUDED") {
      reasonCode = "ONLY_EXCLUDED";
      reasonMessage = t("plan_reason_only", { only: request.only.join(", ") });
    } else if (reason === "NOT_SELECTED" || !decision) {
      reasonCode = "NOT_SELECTED";
      reasonMessage = t("plan_reason_not_selected");
    } else {
      reasonCode = "DISABLED";
      reasonMessage = t("plan_reason_disabled", { selector: decision.selector, where: where(decision) });
    }
    const includedBy = inclusionOf(bridge ? ADAPTER_ID : p.tool.id);
    const files = new Set<string>();
    /** Files of the configuration folder (relative to it), as opposed to the files an adapter names. */
    const fromConfig = new Set<string>();
    for (const d of [decision, ...p.eff.overridden]) if (d?.file) fromConfig.add(d.file);
    for (const inc of includedBy) if (inc.file) fromConfig.add(inc.file);
    for (const f of fromConfig) files.add(f);
    for (const f of ext?.plan.configFiles ?? []) files.add(f.file);
    const bridgeConfig = bridge && subId ? bridgeConfigs.files.find((f) => f.subcheck === subId) : undefined;
    if (bridgeConfig) files.add(bridgeConfig.file);
    const effectiveCmd = bridge && on && subId && isConfigurable(subId) && invoked.has(subId) ? effectiveCommand(subId, { config: bridgeConfig?.file ?? null, secrets: selection.secrets }) : null;
    const unproven = ext?.plan.uncredited?.[p.capability];
    if (unproven !== undefined) uncredited.set(`${p.tool.id}#${p.capability}`, unproven);
    const limitations = [...(sub?.limitations ?? []), ...(ext?.plan.limitations ?? []), ...(unproven !== undefined ? [unproven] : [])];
    const network = ext ? ext.plan.network : bridge && limitations.some((l) => /network/i.test(l));
    const itemCommand: PlanCommand | null = ext
      ? on
        ? { invocation: p.tool.id, ...ext.plan.command, args: [...ext.plan.command.args], env: { ...ext.plan.command.env } }
        : null
      : on && executable && command
        ? { ...command, args: [...command.args], env: { ...command.env }, stdin: command.stdin ? { ...command.stdin } : null }
        : null;
    const granularity: PlanItem["granularity"] = p.tool.component ? "component" : "workspace";
    const languages = ext?.adapter.manifest.languages;
    const refs = (p.tool.component ? componentRefs.filter((c) => c.id === p.tool.component) : componentRefs).filter((c) => !languages || (c.language !== null && languages.includes(c.language)));
    const available = runtime.interpreter !== null && runtime.sidecarDir !== null;
    items.push({
      id,
      identity: contentHash({
        tool: p.tool.id,
        capability: p.capability,
        adapter: adapterId,
        granularity,
        components: refs.map((c) => c.id),
        command: itemCommand ? { executable: itemCommand.executable, args: itemCommand.args, stdin: itemCommand.stdin } : null,
      }),
      tool: p.tool.id,
      adapter: adapterId,
      subcheck: subId,
      label: sub?.label ?? ext?.plan.label ?? p.tool.id,
      category: capCategory.get(p.capability) ?? null,
      capabilities: [p.capability],
      components: refs,
      languages: uniqueSorted(refs.map((c) => c.language).filter((l): l is string => l !== null)),
      granularity,
      scope: { requested: request.scope, effective: bridge || ext ? "full" : request.scope, context: bridge ? [...(qualityBridgeManifest.minimumContext ?? ["workspace"])] : [granularity] },
      requirement: !on ? "optional" : subPlan?.skipMeans === "not_applicable" ? "conditional" : "required",
      conditions: [...(sub?.conditions ?? []), ...(ext?.plan.conditions ?? [])],
      limitations,
      reason: { code: reasonCode, message: reasonMessage },
      origin: originOf(decision, reason),
      includedBy,
      state: {
        enabled: on,
        origin,
        originLabel: origin ? t(`plan_origin_${origin}`, { source: (decision?.source ?? "-").replace(/^profile:/, ""), file: decision?.file ?? "-" }) : t("plan_origin_none"),
        reason,
        decision,
        overridden: p.eff.overridden,
        runOnly: decision?.layer === "call" && decision.source !== "--profile",
        locked: p.eff.locked ?? [],
      },
      command: itemCommand,
      runtime: ext ? ext.plan.runtime : bridge ? { name: "python", interpreter: runtime.interpreter, available } : null,
      versions: {
        adapter: bridge ? qualityBridgeManifest.adapterVersion : (ext?.adapter.manifest.adapterVersion ?? null),
        tool: bridge ? qualityBridgeManifest.toolName : (ext?.adapter.manifest.toolName ?? null),
        toolVersion: bridge ? runtime.toolVersion : (ext?.plan.toolVersion ?? null),
        rules: null,
      },
      // Under a CI policy the configuration folder is not the analyzed one: its files are named by absolute path, so the
      // run checks them where they are (the policy), never in the snapshot of the commit.
      configFiles: [...files].sort().map(fileRef).map((f) => (configDir !== dir && fromConfig.has(f.file) && !isBuiltinRef(f.file) && !path.isAbsolute(f.file) ? { ...f, file: path.join(configDir, ...f.file.split("/")) } : f)),
      network,
      effects: {
        readsCode: true,
        writesOutputs: bridge || ext !== undefined,
        mayChangeCode: false,
        executesProjectCode: limitations.some((l) => /executes project code/i.test(l)),
        workspaceWrites: bridge ? [...(qualityBridgeManifest.redirection?.unavoidableWorkspaceWrites ?? [])] : [],
        ...(ext?.plan.effects ?? {}),
      },
      limits: { timeoutSeconds },
      output: ext ? ext.plan.output : { format: "json", schema: bridge ? "bridge-response.schema.json" : null },
      dependsOn: [],
      availability: !executable
        ? { status: "not_executable", reason: t("plan_reason_no_adapter", { tool: p.tool.id, where: where(decision) }) }
        : ext
          ? ext.plan.availability
          : available
          ? { status: "available", reason: null }
          : { status: "unavailable", reason: runtime.interpreter === null ? t("plan_python_missing", { python: runtime.logical }) : t("plan_sidecar_missing") },
      bridge: bridge && subPlan ? { skipMeans: subPlan.skipMeans, invoked: invoked.has(subId as string), ...(effectiveCmd ? { effectiveCommand: effectiveCmd } : {}) } : null,
    });
  }
  const unique = dedupeItems(items);
  const willRun = unique.filter((i) => i.state.enabled && i.availability.status !== "not_executable");
  const notApplicable = unique.filter((i) => !willRun.includes(i));

  // 6. Requirements (what the profile, templates, project and policy select, without this run's flags) and coverage.
  const parentOf = (toolId: string): string | null => universe.tools.find((x) => x.id === toolId)?.parent ?? null;
  const claims = (i: PlanItem, selector: string): boolean => {
    if (!coverSelectors(i, parentOf(i.tool)).includes(selector)) return false;
    return !(uncredited.has(i.id) && /^(capability|category):/.test(selector));
  };
  const coveredBy = (selector: string, pool: PlanItem[]): string[] => pool.filter((i) => claims(i, selector)).map((i) => i.id);
  const requirements: PlanRequirement[] = [];
  for (const cap of selBase.items.filter((i) => i.kind === "capability" && i.enabled)) {
    let requiredBy = cap.decision;
    if (!requiredBy) {
      const pair = pairs.find((p) => p.capability === cap.id && p.base?.enabled);
      requiredBy = pair?.base?.decision ?? null;
    }
    requirements.push({ selector: cap.selector, kind: "capability", category: capCategory.get(cap.id) ?? null, requiredBy, coveredBy: coveredBy(cap.selector, willRun) });
  }
  for (const lock of selBase.locks) {
    if (requirements.some((r) => r.selector === lock.selector)) continue;
    requirements.push({ selector: lock.selector, kind: "lock", category: null, requiredBy: lock, coveredBy: coveredBy(lock.selector, willRun) });
  }
  const uncovered: UncoveredRequirement[] = [];
  for (const r of requirements) {
    if (r.coveredBy.length > 0) continue;
    const candidates = unique.filter((i) => i.availability.status !== "not_executable" && claims(i, r.selector));
    const unproven = unique.filter((i) => i.availability.status !== "not_executable" && i.state.enabled && uncredited.has(i.id) && coverSelectors(i, parentOf(i.tool)).includes(r.selector));
    const effCap = r.kind === "capability" ? selEff.items.find((i) => i.selector === r.selector) : undefined;
    const runDecision = candidates.find((i) => i.state.runOnly)?.state.decision ?? (effCap?.decision?.layer === "call" ? effCap.decision : null);
    let reason: UncoveredRequirement["reason"];
    let disabledBy: SelectionDecision | null = null;
    if (unproven.length > 0 && !candidates.some((c) => c.state.enabled)) reason = "EVIDENCE_MISSING";
    else if (candidates.length === 0) reason = "NO_EXECUTABLE_CHECK";
    else if (runDecision) {
      reason = "DISABLED_FOR_RUN";
      disabledBy = runDecision;
    } else {
      reason = "CHECKS_DISABLED";
      disabledBy = candidates.map((i) => i.state.decision).find((d): d is SelectionDecision => d !== null) ?? null;
    }
    const key = { NO_EXECUTABLE_CHECK: "plan_uncovered_no_check", DISABLED_FOR_RUN: "plan_uncovered_for_run", CHECKS_DISABLED: "plan_uncovered_checks_disabled", EVIDENCE_MISSING: "plan_uncovered_evidence_missing" }[reason];
    uncovered.push({
      ...r,
      reason,
      message: t(key, { selector: r.selector, by: disabledBy ? (disabledBy.file ? where(disabledBy) : disabledBy.source) : "-", detail: unproven.map((i) => uncredited.get(i.id)).join("; ") }),
      disabledBy,
      runOnly: reason === "DISABLED_FOR_RUN",
      candidates: candidates.map((i) => i.id),
    });
  }

  // 7. What --skip and --only changed, relative to the plan without them.
  const baseOn = new Map(pairs.map((p) => [`${p.tool.id}#${p.capability}`, p.base?.enabled ?? false]));
  const overridesOut: SelectionOverride[] = [];
  for (const selector of request.only) {
    overridesOut.push({
      source: "--only",
      selector,
      value: true,
      items: unique.filter((i) => i.state.enabled && i.state.decision?.selector === selector && i.state.decision.source === "--only" && baseOn.get(i.id) !== true).map((i) => i.id),
    });
  }
  if (request.only.length > 0) {
    overridesOut.push({ source: "--only", selector: null, value: false, items: unique.filter((i) => i.state.reason === "ONLY_EXCLUDED" && baseOn.get(i.id) === true).map((i) => i.id) });
  }
  // A PII entity is not a plan item of its own: --skip pii:<entity> narrows the builtin-pii item when the entity ran.
  const piiEntityRan = (sel: SelectionResult, config: Record<string, unknown>, entity: string): boolean =>
    entityStates(config, sel).some((e) => e.id === entity && e.enabled);
  for (const selector of request.skip) {
    const piiEntity = selector.startsWith("pii:") ? selector.slice(4) : null;
    const piiItems =
      piiEntity !== null && piiEntityRan(selBase, baseline.config, piiEntity) && !piiEntityRan(selEff, effective.config, piiEntity)
        ? unique.filter((i) => i.adapter === "builtin-pii" && i.state.enabled).map((i) => i.id)
        : [];
    overridesOut.push({
      source: "--skip",
      selector,
      value: false,
      items:
        piiEntity !== null
          ? piiItems
          : unique.filter((i) => !i.state.enabled && i.state.decision?.selector === selector && i.state.decision.source === "--skip" && baseOn.get(i.id) === true).map((i) => i.id),
    });
  }
  const reduced = overridesOut.some((o) => !o.value && o.items.length > 0) || uncovered.some((u) => u.reason === "DISABLED_FOR_RUN");

  // 8. Forced templates without a compatible component.
  const incompatibilities: TemplateIncompatibility[] = [];
  for (const a of effective.templates.active) {
    if (a.reason !== "ALWAYS" && a.reason !== "REQUESTED") continue;
    const m = matches.get(a.id);
    if (!m) continue;
    if (approvable.some((c) => fits(c, m))) continue;
    const listed = approvable.map((c) => ({ id: c.id, language: c.language, framework: c.framework }));
    incompatibilities.push({
      code: "TEMPLATE_INCOMPATIBLE",
      template: a.id,
      source: a.source,
      activation: a.reason,
      match: m,
      components: listed,
      message: t("plan_template_incompatible", {
        template: a.id,
        source: a.source,
        activation: t(`plan_activation_${a.reason}`),
        match: [...m.languages, ...m.frameworks].join(", "),
        components: listed.length > 0 ? listed.map((c) => `${c.id} (${c.language ?? "-"}${c.framework ? `/${c.framework}` : ""})`).join(", ") : t("plan_no_components"),
      }),
    });
  }

  // 9. Network, approvability and blocking (fail-closed).
  const networkItems = unique.filter((i) => i.network && (i.state.enabled || i.bridge?.invoked)).map((i) => i.id);
  const warnings: PlanBody["warnings"] = [];
  const blockers: PlanBlocker[] = [];
  const runsAnyway = [...invoked].filter((s) => !bridgePairs.some((p) => p.tool.id === `${ADAPTER_ID}.${s}` && isOn(p))).sort();
  warnings.push(...duplicateScanners(superseded, bridgePairs.filter(isOn).map((p) => ({ subcheck: subOf(p), capability: p.capability }))));
  warnings.push(
    ...duplicateLinters(
      pairs.filter((p) => p.tool.parent === null && selectedPair(p)).map((p) => ({ tool: p.tool.id, adapter: adapterOfTool(p.tool.id), capability: p.capability })),
      bridgePairs.filter(isOn).map((p) => ({ subcheck: subOf(p), capability: p.capability })),
    ),
  );
  if (runsAnyway.length > 0) warnings.push({ code: "BRIDGE_RUNS_DISABLED", message: t("plan_runs_anyway", { subchecks: runsAnyway.join(", "), mode: selection.mode }) });
  const effectiveScope: PlanScopeKind = willRun.length > 0 && willRun.every((i) => i.scope.effective === "full") ? "full" : request.scope;
  const scopeNote = effectiveScope !== request.scope ? t("plan_scope_widened", { scope: request.scope }) : null;
  if (scopeNote) warnings.push({ code: "SCOPE_WIDENED", message: scopeNote });
  const hard = uncovered.filter((u) => u.reason !== "DISABLED_FOR_RUN");
  if (hard.length > 0) blockers.push({ code: "REQUIREMENT_UNCOVERED", message: t("plan_blocker_uncovered", { count: hard.length, selectors: hard.map((u) => u.selector).join(", ") }), items: hard.map((u) => u.selector) });
  // A tool the adapter reports at run time (stage blocked, decision incomplete) is a warning here, not a blocker.
  // The bridge is one of them: without its Python or its sidecar the run is still recorded, with the bridge stage
  // blocked by the runner's preflight (fail-closed, never passed), instead of being refused before it starts.
  const lateOnly = (i: PlanItem): boolean => i.adapter === ADAPTER_ID || externals.get(i.tool)?.plan.blocksPlan === false;
  const lateWarned = new Set<string>();
  for (const i of willRun) {
    if (i.availability.status !== "available" && lateOnly(i)) {
      const message = i.availability.reason ?? i.tool;
      // One warning per reason: the bridge's subchecks share the same missing runtime.
      if (lateWarned.has(message)) continue;
      lateWarned.add(message);
      warnings.push({ code: "TOOL_UNAVAILABLE", message });
    }
  }
  const unavailable = willRun.filter((i) => i.availability.status !== "available" && !lateOnly(i));
  if (unavailable.length > 0) blockers.push({ code: "TOOL_UNAVAILABLE", message: unavailable[0]?.availability.reason ?? t("plan_sidecar_missing"), items: unavailable.map((i) => i.id) });
  // A configuration file a planned tool reads that does not parse blocks the plan, with the file and the line.
  const configTools = [...new Set(willRun.map((i) => i.tool))];
  const bridgeFileOf = (tool: string): string[] => bridgeConfigs.files.filter((f) => `${ADAPTER_ID}.${f.subcheck}` === tool).map((f) => f.file);
  const configExtra = Object.fromEntries(
    configTools.map((tool) => [tool, [...(externals.get(tool)?.plan.configFiles ?? []).map((f) => f.file), ...bridgeFileOf(tool)].map((f) => path.resolve(dir, f))]),
  );
  // The bindings are those of the configuration folder (the policy's, under a CI policy), never the analyzed files'.
  for (const bad of invalidToolConfigs(configDir, configTools, configExtra)) {
    blockers.push({
      code: "CONFIG_INVALID",
      message: t("plan_blocker_config_invalid", { file: bad.line === null ? bad.file : `${bad.file}:${bad.line}`, tools: bad.tools.join(", "), message: bad.message }),
      items: bad.tools,
    });
  }
  // A bound scanner configuration the sidecar would refuse blocks the plan here, with the binding that names it.
  for (const problem of bridgeConfigs.problems) {
    const items = willRun.filter((i) => i.tool === `${ADAPTER_ID}.${problem.subcheck}`).map((i) => i.id);
    blockers.push({ code: problem.code, message: t(`plan_blocker_${problem.code.toLowerCase()}`, { subcheck: problem.subcheck, file: problem.declared }), items });
  }
  if (networkPolicy === "deny" && networkItems.length > 0) blockers.push({ code: "NETWORK_DENIED", message: t("plan_network_denied", { items: networkItems.join(", ") }), items: networkItems });
  const blocked: PlanBlocker | null =
    willRun.length === 0
      ? requirements.length > 0
        ? { code: "PLAN_EMPTY", message: t("plan_blocked_empty", { count: requirements.length }), items: requirements.map((r) => r.selector) }
        : { code: "PLAN_EMPTY", message: t("plan_blocked_nothing") }
      : null;

  const wsId = fs.existsSync(workspaceDir) ? workspaceId(workspaceDir) : "ws_unknown";
  const body: PlanBody = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    kind: PLAN_KIND,
    workspace: { path: workspaceDir, id: wsId },
    versions: {
      jgates: options.version ?? readVersion(),
      detector: inventory.detectorVersion,
      adapters: { [ADAPTER_ID]: qualityBridgeManifest.adapterVersion, ...Object.fromEntries([...externals.values()].map((e) => [e.adapter.manifest.id, e.adapter.manifest.adapterVersion])) },
      tools: { [qualityBridgeManifest.toolName]: runtime.toolVersion, ...Object.fromEntries([...externals.values()].map((e) => [e.adapter.manifest.toolName, e.plan.toolVersion])) },
    },
    profile: effective.profile ? { id: effective.profile.id, label: effective.profile.label, chain: effective.profile.chain.map((c) => ({ ...c })) } : null,
    // The references as full commit ids (the request keeps them as typed): a plan of HEAD~1 stays the plan of that commit.
    scope: { requested: request.scope, effective: effectiveScope, paths: request.paths, base: refs.base, head: refs.head, note: scopeNote },
    selection: { request, overrides: overridesOut, reduced },
    components,
    templates: {
      active: effective.templates.active.map((a) => ({ id: a.id, source: a.source, reason: a.reason, matched: [...(a.matched ?? [])], chain: [...a.chain], ...supportOf(a.source) })),
      inactive: effective.templates.inactive.map((a) => ({ id: a.id, source: a.source, reason: a.reason })),
    },
    incompatibilities,
    invocations: [
      ...(command ? [{ id: ADAPTER_ID, adapter: ADAPTER_ID, command, subchecks: [...invoked].sort(), runsAnyway }] : []),
      ...[...externals.entries()]
        .filter(([id]) => pairs.some((p) => p.tool.id === id && isOn(p)))
        .map(([id, e]) => ({ id, adapter: e.adapter.manifest.id, command: { invocation: id, ...e.plan.command, args: [...e.plan.command.args], env: { ...e.plan.command.env } }, subchecks: [], runsAnyway: [], ...(e.plan.contract ? { contract: e.plan.contract } : {}) })),
    ],
    groups: { willRun, notApplicableOrDisabled: notApplicable, uncoveredRequirements: uncovered },
    requirements,
    network: { policy: networkPolicy, required: networkItems.length > 0, items: networkItems },
    architecture: architectureOf(configDir),
    inputs: {
      configFiles: [...hashes.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([file, hash]) => ({ file, sha256: hash })),
      inventoryHash: contentHash({
        detectorVersion: inventory.detectorVersion,
        mode: inventory.mode,
        templatesActive: inventory.templatesActive,
        configFile: inventory.configFile,
        classifications: inventory.classifications,
        languages: inventory.languages,
        inconsistencies: inventory.inconsistencies,
      }),
      configHash: contentHash(effective.config),
    },
    approvable: blocked === null && blockers.length === 0,
    blocked,
    blockers,
    warnings,
  };
  // JSON round trip: the hash is computed over exactly what is written and read back.
  const clean = JSON.parse(JSON.stringify(body)) as PlanBody;
  const plan: Plan = { ...clean, planHash: computePlanHash(clean), createdAt: (options.now ?? new Date()).toISOString(), changes: null };
  if (options.compare !== false) {
    const previous = readLastPlan(options.home ?? resolveHome({ env }), wsId);
    if (previous) plan.changes = diffPlans(previous, plan);
  }
  return { ok: true, plan };
}
