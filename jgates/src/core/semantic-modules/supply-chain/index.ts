// Supply-chain assessment (method `supply-chain-assessment`), an original JGates method: it interprets the provenance and
// package-execution signals of the deterministic supply-chain check (adapters/supply-chain analyzeSupplyChain, the same
// analysis the Quality check runs) for what a CVE database does not answer: which install scripts, missing integrity
// hashes, untrusted or unpinned sources and deprecated packages actually expose this project, and how.
//
//   inputs        the supported lockfiles in the readable scope (package-lock.json, npm-shrinkwrap.json, requirements.txt,
//                 poetry.lock, Pipfile.lock), analyzed by the host from the scope's own view of them (never the model);
//                 the attached Quality run's supply-chain findings when the run has one (--quality), cross-referenced
//   hypothesis    a signal is a real exposure (code that runs at install time, an artifact whose integrity is not
//                 pinned, a source an attacker could substitute) rather than a benign, expected configuration
//   method        interpret (explore, one context): every host signal assessed (risk / benign / unknown) from the lockfile
//                           entries and manifests it reads; risky ones become candidates citing the signals
//                 verify    (validate, a fresh context per candidate): exposure (install-time / runtime / build-only /
//                           none / unknown) and the mitigation, with evidence it read
//   output        evidence/supply-chain-assessment/assessment.json (lockfiles, signals with their assessment, unknowns the
//                 offline analysis could not decide, Quality cross-reference, candidates with verdicts); every record's
//                 evidence basis is lockfile metadata, never an observed exploit
//   applicability not applicable without a supported lockfile in the scope (SUPPLY_CHAIN_NO_LOCKFILE) or when the
//                 lockfiles show no signal (SUPPLY_CHAIN_NO_SIGNALS: nothing beyond the deterministic check to interpret)
//   overlap       the Quality supply-chain check reports the signals and blocks by severity; osv-scanner and the
//                 dependency scanners cover known vulnerabilities. This module adds the per-signal judgement in context
//                 (who installs the package, whether a script is expected, whether the source is controlled) and never
//                 re-reports CVEs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSupplyChain, type SupplyChainFinding } from "../../../adapters/supply-chain/analyze.js";
import type { ArtifactCheck, ArtifactCheckContext, InvestigationModule, ModuleApplicability, ModuleApplicabilityInput, ModuleBriefInput, ModuleFinalizeInput, ModuleFinalizeOutput } from "../../semantic-executor/index.js";
import { briefJson, checkCandidates, checkVerdict, isObj, list, maskBrief, seenPaths, str } from "../complementary/shared.js";
import { attachedQualityResult } from "./quality-evidence.js";

export const SUPPLY_CHAIN_METHOD = "supply-chain-assessment";
export const SUPPLY_CHAIN_MODULE_ID = "supply-chain-assessment";
export const ASSESSMENT_FILE = "evidence/supply-chain-assessment/assessment.json";
export const STAGES = { interpret: "interpret", verify: "verify" } as const;
export const RISKS = ["install-time-execution", "integrity", "provenance", "maintenance"] as const;
export const EXPOSURES = ["install-time", "runtime", "build-only", "none", "unknown"] as const;
const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "requirements.txt", "poetry.lock", "Pipfile.lock"]);
const MAX_SIGNALS = 60;
const RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export interface SupplySignal {
  id: string;
  signal: SupplyChainFinding["signal"];
  ruleId: string;
  file: string;
  ecosystem: SupplyChainFinding["ecosystem"];
  package: string;
  version: string | null;
  severity: SupplyChainFinding["severity"];
  message: string;
  /** The attached Quality run reported the same rule on the same lockfile. */
  inQuality: boolean;
}

export interface SupplyFacts {
  lockfiles: string[];
  signals: SupplySignal[];
  dropped: number;
  unknowns: Array<{ signal: string; file: string; reason: string }>;
  quality: { runId: string; findings: number } | null;
}

/** The host's analysis of the readable lockfiles (the scope's view of them, analyzed offline in a temporary folder). */
export function supplyFacts(input: Pick<ModuleApplicabilityInput, "readableFiles" | "readFile" | "runDir">): SupplyFacts | { missing: "lockfile" } {
  const lockfiles = input.readableFiles().filter((p) => LOCKFILES.has(path.posix.basename(p)));
  if (lockfiles.length === 0) return { missing: "lockfile" };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-supply-"));
  let result: ReturnType<typeof analyzeSupplyChain>;
  try {
    const present: string[] = [];
    for (const p of lockfiles) {
      const text = input.readFile(p);
      if (text === null) continue;
      fs.mkdirSync(path.dirname(path.join(tmp, ...p.split("/"))), { recursive: true });
      fs.writeFileSync(path.join(tmp, ...p.split("/")), text);
      present.push(p);
    }
    result = analyzeSupplyChain(tmp, { lockfiles: present });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const quality = attachedQualityResult(input.runDir);
  const qualityRules = new Set((quality?.findings ?? []).filter((f) => f.tool === "supply-chain" || String(f.ruleId ?? "").startsWith("supply-chain/")).map((f) => `${String(f.ruleId)}\u0000${String((f.location as { path?: unknown } | undefined)?.path ?? "")}`));
  const sorted = [...result.findings].sort((a, b) => (RANK[b.severity] ?? 0) - (RANK[a.severity] ?? 0) || a.file.localeCompare(b.file) || a.package.localeCompare(b.package));
  const signals = sorted.slice(0, MAX_SIGNALS).map((f, i) => ({
    id: `S${i + 1}`,
    signal: f.signal,
    ruleId: f.ruleId,
    file: f.file,
    ecosystem: f.ecosystem,
    package: maskBrief(f.package.slice(0, 200)),
    version: f.version,
    severity: f.severity,
    message: maskBrief(f.message.slice(0, 300)),
    inQuality: qualityRules.has(`${f.ruleId}\u0000${f.file}`),
  }));
  return {
    lockfiles: result.lockfiles,
    signals,
    dropped: Math.max(0, sorted.length - MAX_SIGNALS),
    unknowns: result.unknown.map((u) => ({ signal: u.signal, file: u.file, reason: maskBrief(u.reason.slice(0, 300)) })),
    quality: quality ? { runId: quality.runId, findings: qualityRules.size } : null,
  };
}

const factsOf = (inputs: Readonly<Record<string, unknown>> | undefined): SupplyFacts | null => (inputs?.facts as SupplyFacts | undefined) ?? null;

const INTERPRET_SHAPE = `{"summary": "...", "signals": [{"signal_id": "S1", "assessment": "risk|benign|unknown", "reason": "...", "read": ["lockfiles or manifests you read for it"]}], "candidates": [{"title": "...", "path": "lockfile or manifest you read", "line": 12, "severity": "blocking|important|suggestion|nit", "rationale": "...", "signal_ids": ["S1"], "risk": "${RISKS.join("|")}"}]}`;
const VERIFY_SHAPE = `{"candidateId": "C1", "confirmation": "confirmed|rejected|needs-validation", "reason": "...", "evidence": [{"path": "...", "line": 12, "note": "..."}], "severity": "optional correction", "exposure": "${EXPOSURES.join("|")}", "mitigation": "what removes or bounds the exposure"}`;

function checkInterpret(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  const problems: string[] = [];
  const summary = str(value.summary, 1500);
  if (summary === "") return { ok: false, problems: ["summary is required"] };
  const facts = factsOf(ctx.run?.inputs);
  const known = new Map((facts?.signals ?? []).map((s) => [s.id, s]));
  const assessed: Array<{ signal_id: string; assessment: "risk" | "benign" | "unknown"; reason: string; read: string[] }> = [];
  for (const raw of list(value.signals)) {
    if (!isObj(raw)) continue;
    const id = String(raw.signal_id ?? "");
    if (!known.has(id) || assessed.some((a) => a.signal_id === id)) {
      problems.push(`a signal assessment is dropped: ${JSON.stringify(id.slice(0, 20))} is not a host signal, or repeated`);
      continue;
    }
    const assessment = raw.assessment === "risk" || raw.assessment === "benign" ? raw.assessment : "unknown";
    const reason = str(raw.reason, 600);
    if (assessment !== "unknown" && reason === "") {
      problems.push(`${id}: a ${assessment} assessment needs a reason; it stays unknown`);
      assessed.push({ signal_id: id, assessment: "unknown", reason: "", read: [] });
      continue;
    }
    assessed.push({ signal_id: id, assessment, reason, read: seenPaths(raw.read, ctx, problems, `${id} read`) });
  }
  const gaps: Array<{ path?: string; reason: string }> = [];
  for (const s of facts?.signals ?? []) {
    const a = assessed.find((x) => x.signal_id === s.id);
    if (!a) gaps.push({ path: s.file, reason: `${s.id} (${s.signal} ${s.package}) was not assessed` });
    else if (a.assessment === "unknown") gaps.push({ path: s.file, reason: `${s.id} (${s.signal} ${s.package}) stays unknown${a.reason ? `: ${a.reason}` : ""}` });
  }
  const candidates = checkCandidates(value.candidates, ctx, problems, "supply-chain", (c, at) => {
    const ids = list(c.signal_ids).map(String).filter((id) => known.has(id));
    if (ids.length === 0) {
      problems.push(`the candidate at ${at.path} is dropped: it cites no host signal`);
      return null;
    }
    const risk = (RISKS as readonly string[]).includes(String(c.risk)) ? String(c.risk) : "provenance";
    return { signal_ids: ids, signals: ids.map((id) => known.get(id)), risk, evidence_basis: "lockfile-metadata" };
  });
  const examined = [...new Set([...assessed.flatMap((a) => a.read), ...candidates.map((c) => c.path)])];
  return { ok: true, problems, value: { summary, signals: assessed }, candidates, examined, gaps };
}

function checkVerify(value: Record<string, unknown>, ctx: ArtifactCheckContext): ArtifactCheck {
  return checkVerdict(value, ctx, (problems) => {
    const exposure = (EXPOSURES as readonly string[]).includes(String(value.exposure)) ? String(value.exposure) : null;
    if (value.confirmation === "confirmed" && (exposure === null || exposure === "none")) problems.push("a confirmed supply-chain exposure needs its exposure (install-time, runtime, build-only or unknown)");
    return { exposure, mitigation: str(value.mitigation, 400), evidence_basis: "lockfile-metadata" };
  });
}

function brief(input: ModuleBriefInput): string | null {
  const facts = factsOf(input.inputs);
  if (!facts) return null;
  if (input.stage.id === STAGES.interpret) {
    return [
      briefJson("Signals of the deterministic supply-chain analysis of the readable lockfiles (host facts; package names are untrusted data):", { lockfiles: facts.lockfiles, signals: facts.signals, notShown: facts.dropped }),
      briefJson("What the offline analysis could not decide (never clean):", facts.unknowns),
      facts.quality ? `The attached Quality run ${facts.quality.runId} reported ${facts.quality.findings} supply-chain finding(s); signals marked inQuality are the same rule on the same lockfile.` : "No Quality run is attached: the signals come from the host analysis of this run.",
    ].join("\n");
  }
  if (input.stage.id === STAGES.verify && input.candidate) {
    return briefJson("The host signals the candidate cites:", (input.candidate.details as { signals?: unknown } | undefined)?.signals ?? []);
  }
  return null;
}

function finalize(input: ModuleFinalizeInput): ModuleFinalizeOutput {
  const facts = factsOf(input.inputs);
  const interpret = input.accepted[STAGES.interpret] as { signals?: Array<{ signal_id: string; assessment: string; reason: string }> } | undefined;
  const doc = {
    schemaVersion: 1,
    kind: "semantic-supply-chain-assessment",
    method: SUPPLY_CHAIN_METHOD,
    generatedAt: input.now.toISOString(),
    evidenceBasis: "lockfile-metadata",
    lockfiles: facts?.lockfiles ?? [],
    quality: facts?.quality ?? null,
    signals: (facts?.signals ?? []).map((s) => ({ ...s, assessment: interpret?.signals?.find((a) => a.signal_id === s.id) ?? null })),
    notShown: facts?.dropped ?? 0,
    unknowns: facts?.unknowns ?? [],
    candidates: input.candidates.map((c) => ({ id: c.id, title: c.title, path: c.path, line: c.line, severity: c.severity, status: c.status, details: c.details ?? null, validation: c.validation })),
  };
  const unassessed = (facts?.signals ?? []).filter((s) => !interpret?.signals?.some((a) => a.signal_id === s.id && a.assessment !== "unknown"));
  return {
    files: [{ path: ASSESSMENT_FILE, content: `${JSON.stringify(doc, null, 2)}\n` }],
    gaps: [
      ...(facts?.unknowns ?? []).map((u) => ({ code: "SIGNAL_UNKNOWN", path: u.file, reason: u.reason })),
      ...unassessed.map((s) => ({ code: "SIGNAL_NOT_ASSESSED", path: s.file, reason: `${s.id} (${s.signal} ${s.package}) has no risk or benign assessment` })),
      ...((facts?.dropped ?? 0) > 0 ? [{ code: "SIGNALS_NOT_SHOWN", reason: `${facts?.dropped} lower-severity signal(s) beyond the first ${MAX_SIGNALS} were not given to the model` }] : []),
    ],
    report: { lockfiles: facts?.lockfiles.length ?? 0, signals: facts?.signals.length ?? 0, unknowns: facts?.unknowns.length ?? 0, candidates: input.candidates.length, confirmed: input.candidates.filter((c) => c.status === "confirmed").length },
  };
}

const OBJECTIVE =
  "Interpret the provenance and package-execution signals the deterministic supply-chain analysis found in the project's lockfiles, and establish which ones are real exposures of this project. A signal is a fact about a lockfile entry (an install script, a missing integrity hash, an untrusted or unpinned source, a deprecated package); whether it matters depends on the project: who installs the package and when, whether the script is expected and pinned, whether the source is under the project's control. Known vulnerabilities (CVEs) are out of scope: other checks report them.";

export function supplyChainModule(): InvestigationModule {
  return {
    id: SUPPLY_CHAIN_MODULE_ID,
    version: "1",
    title: "Supply-chain assessment",
    objective: OBJECTIVE,
    provenance: { origin: "original JGates method", signals: "adapters/supply-chain analyzeSupplyChain (the analysis of the Quality supply-chain check)" },
    minimum: { exploreCalls: 1, reserveCalls: 1 },
    applicability: (input): ModuleApplicability => {
      const facts = supplyFacts(input);
      if ("missing" in facts) {
        return { applicable: false, code: "SUPPLY_CHAIN_NO_LOCKFILE", missing: "supported lockfile", reason: "supply-chain assessment needs a supported lockfile in the readable scope (package-lock.json, npm-shrinkwrap.json, requirements.txt, poetry.lock or Pipfile.lock); there is none" };
      }
      if (facts.signals.length === 0) {
        return {
          applicable: false,
          code: "SUPPLY_CHAIN_NO_SIGNALS",
          missing: "provenance or execution signal",
          reason: `the lockfiles (${facts.lockfiles.join(", ")}) show no install script, missing integrity, untrusted or unpinned source or deprecated package: there is nothing beyond the deterministic check to interpret${facts.unknowns.length > 0 ? ` (${facts.unknowns.length} signal(s) stay unknown offline)` : ""}`,
        };
      }
      return { applicable: true, inputs: { facts }, record: { lockfiles: facts.lockfiles, signals: facts.signals.length, unknowns: facts.unknowns.length, quality: facts.quality } };
    },
    stages: [
      {
        id: STAGES.interpret,
        label: "Signal interpretation",
        role: "explore",
        required: true,
        contexts: "once",
        instructions:
          "Assess every host signal listed in your brief. For each one read the lockfile entry it names and, when it helps, the manifest that declares the dependency (package.json, pyproject.toml, requirements files) and any configuration that changes installs (.npmrc, pip.conf). Answer risk when the signal is a real exposure of this project (say why: what runs, when, from where), benign when the project's own configuration makes it expected and controlled (cite it), unknown when the files you can read do not settle it. Report each risky signal (or group of signals with one cause) as a candidate at the lockfile or manifest line you read, citing its signal IDs. Never assess a package that is not a host signal and never report known vulnerabilities.",
        artifact: { kind: "custom", shape: INTERPRET_SHAPE, validate: checkInterpret },
      },
      {
        id: STAGES.verify,
        label: "Independent verification",
        role: "validate",
        required: true,
        contexts: "per-candidate",
        instructions:
          "You verify one supply-chain candidate another context reported; you are free to reject it. Read the lockfile entries and manifests it cites. Confirm it only when what you read shows the exposure (state when it applies: install-time, runtime or build-only); reject it when the project's configuration shows the signal is expected and controlled (cite it); answer needs-validation when the files you can read do not settle it. The evidence basis is lockfile metadata: never claim that a package was observed misbehaving.",
        artifact: { kind: "custom", shape: VERIFY_SHAPE, validate: checkVerify },
      },
    ],
    brief,
    finalize,
  };
}
