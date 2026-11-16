#!/usr/bin/env node
// pack:check <language> <group>: proves one rule file of the bundled Semgrep pack with a local Semgrep.
//
//   npm --prefix jgates run pack:check -- <language> <group>
//
// For that one rule file it runs, in this order of reporting:
//   gates      the pack gates for this file only (ids, prefix, metadata, ASVS ids, a ruleid: and an ok: case per rule, the expected file)
//   validate   `semgrep --validate` on the rule file
//   test       `semgrep --test` on the rule file and its fixture (kept in a private copy)
//   vulnerable a scan of the group's vulnerable twin with the whole pack as configuration: the ids (or signal tags) must equal expected/<language>/<group>.json
//   clean      the same scan of the clean twin: no finding of any rule
// For `javascript` the `typescript` twins are proven the same way.
//
// It needs no build (no import from dist), reads the closed lists from src/adapters/semgrep/pack-lists.json, gives every run its own
// temporary folder and Semgrep profile (so many runs may go at once), and never starts Docker: with no local Semgrep it fails and
// says how to provide one (JGATES_SEMGREP, the repository's .venv, PATH).
//
// JGATES_PACK_CHECK_ROOT (a folder shaped like `jgates/`) points the data (packs, fixtures, lists, vendor) elsewhere: used to try the
// command on a copy of the pack.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const here = path.dirname(fileURLToPath(import.meta.url));
const SELF_ROOT = path.resolve(here, "..");
const DATA_ROOT = process.env.JGATES_PACK_CHECK_ROOT ? path.resolve(process.env.JGATES_PACK_CHECK_ROOT) : SELF_ROOT;
const REPO_ROOT = path.resolve(SELF_ROOT, "..");
const RULES = path.join(DATA_ROOT, "packs", "semgrep", "jgates-semgrep", "rules");
const FIXTURES = path.join(DATA_ROOT, "tests", "fixtures", "semgrep-pack");
const LISTS = JSON.parse(fs.readFileSync(path.join(DATA_ROOT, "src", "adapters", "semgrep", "pack-lists.json"), "utf8"));
const ASVS_FILE = path.join(DATA_ROOT, "vendor", "owasp-asvs", "5.0.0", "OWASP_Application_Security_Verification_Standard_5.0.0_en.flat.json");

const CHECK_GROUPS = ["interpreters", "encoding", "cookies-cors", "web-protocol", "files", "passwords-sessions", "tokens-transport", "crypto-params", "errors-logging", "configuration"];
const FRONTS = ["python", "javascript", "go", "csharp", "rust", "java", "php"];
const GROUPS = {
  ...Object.fromEntries(FRONTS.map((l) => [l, [...CHECK_GROUPS, "signals"]])),
  html: ["markup"],
  config: ["server", "framework"],
};
// Files a group's twin workspace needs beside the files its expected file lists (as the pack test does).
const SUPPORT_FILES = { rust: ["Cargo.toml"] };
const SEMGREP_TIMEOUT_MS = 300_000;

const started = Date.now();
const secs = (since) => `${((Date.now() - since) / 1000).toFixed(1)}s`;
const slash = (p) => p.split(path.sep).join("/");
const tag = `pack:check ${process.argv[2] ?? "?"} ${process.argv[3] ?? "?"}`;

let work = null;
function cleanup() {
  if (work) fs.rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

function finish(ok, text) {
  cleanup();
  console.log(`${tag}: ${ok ? "PASS" : "FAIL"} ${text} (${secs(started)})`);
  process.exit(ok ? 0 : 1);
}

// ---- Arguments -----------------------------------------------------------------------------------------------------------------

const [language, group] = process.argv.slice(2);
if (!language || !group || process.argv.length > 4) {
  console.error("usage: npm --prefix jgates run pack:check -- <language> <group>");
  console.error(`  languages and groups: ${Object.entries(GROUPS).map(([l, g]) => `${l} [${g.join(" ")}]`).join("; ")}`);
  process.exit(2);
}
if (!GROUPS[language] || !GROUPS[language].includes(group)) {
  console.error(`${tag}: unknown language or group. ${GROUPS[language] ? `Groups of ${language}: ${GROUPS[language].join(", ")}.` : `Languages: ${Object.keys(GROUPS).join(", ")}.`}`);
  process.exit(2);
}

// ---- The engine: a local Semgrep, never Docker ------------------------------------------------------------------------------------

function findSemgrep() {
  const explicit = process.env.JGATES_SEMGREP;
  if (explicit) return fs.existsSync(explicit) ? explicit : { missing: `JGATES_SEMGREP points to ${explicit}, which does not exist` };
  for (const rel of [path.join(".venv", "Scripts", "semgrep.exe"), path.join(".venv", "bin", "semgrep")]) {
    const candidate = path.join(REPO_ROOT, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  const names = process.platform === "win32" ? ["semgrep.exe", "semgrep.cmd"] : ["semgrep"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) if (fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}
const semgrep = findSemgrep();
if (semgrep === null || typeof semgrep === "object") {
  console.error(`${tag}: no local Semgrep${semgrep ? ` (${semgrep.missing})` : ""}. Provide one: set JGATES_SEMGREP to a semgrep executable, create the repository's .venv with Semgrep installed (.venv/Scripts/semgrep.exe or .venv/bin/semgrep), or put semgrep on PATH. pack:check never starts Docker.`);
  process.exit(3);
}

work = fs.mkdtempSync(path.join(os.tmpdir(), "jgates-pack-check-"));
let stepSeq = 0;

/** Runs Semgrep with its own throwaway profile; resolves { status, stdout, stderr }. */
function runSemgrep(args, cwd) {
  const home = path.join(work, `home-${++stepSeq}`);
  fs.mkdirSync(home, { recursive: true });
  return new Promise((resolve) => {
    const child = spawn(semgrep, args, {
      cwd,
      windowsHide: true,
      env: { ...process.env, HOME: home, USERPROFILE: home, SEMGREP_SEND_METRICS: "off", SEMGREP_ENABLE_VERSION_CHECK: "0", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), SEMGREP_TIMEOUT_MS);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: `${stderr}${e.message}` });
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

const tail = (text, n = 12) => text.trim().split(/\r?\n/).slice(-n).join("\n");
const oneLine = (text) => text.replace(/\s+/g, " ").trim().slice(0, 300);

// ---- The rule file and the pack ---------------------------------------------------------------------------------------------------

const prefix = LISTS.languages[language];
const ruleRel = language === "python" || language === "javascript" ? `${language}-${group}.yaml` : `${language}/${language}-${language === "html" ? "markup" : group}.yaml`;
const ruleFile = path.join(RULES, ruleRel);
const twinLanguages = language === "javascript" ? ["javascript", "typescript"] : [language];

function listYaml(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listYaml(abs));
    else if (entry.isFile() && entry.name.endsWith(".yaml")) out.push(abs);
  }
  return out;
}

function readRules(file) {
  const doc = parseYaml(fs.readFileSync(file, "utf8"));
  if (!doc || !Array.isArray(doc.rules)) throw new Error("no rules list");
  return doc.rules;
}

/** The ids of every other rule file of the pack, and the (category, CWE) of each family there; a file that does not parse is another slice's business. */
function otherRules() {
  const ids = new Map();
  const families = new Map();
  for (const file of listYaml(RULES)) {
    if (path.resolve(file) === path.resolve(ruleFile)) continue;
    let rules;
    try {
      rules = readRules(file);
    } catch {
      continue;
    }
    for (const r of rules) {
      if (typeof r?.id !== "string") continue;
      ids.set(r.id, slash(path.relative(RULES, file)));
      const meta = r.metadata ?? {};
      if (!meta.signal) families.set(r.id.replace(/^jgates\.[^.]+\./, ""), { kind: `${meta.category} ${meta.cwe}`, id: r.id });
    }
  }
  return { ids, families };
}

/** The annotated fixtures beside a rule file: the same stem with any other extension. */
function fixturesOf(file) {
  const dir = path.dirname(file);
  const stem = path.basename(file).replace(/\.yaml$/, "");
  return fs.readdirSync(dir).filter((n) => n.startsWith(`${stem}.`) && !n.endsWith(".yaml")).map((n) => path.join(dir, n));
}

function readExpected(lang) {
  const file = path.join(FIXTURES, "expected", lang, `${group}.json`);
  if (!fs.existsSync(file)) return { problem: `no expected file ${slash(path.relative(DATA_ROOT, file))}` };
  let expected;
  try {
    expected = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { problem: `${slash(path.relative(DATA_ROOT, file))} is not JSON: ${e.message}` };
  }
  const problems = [];
  if (!Array.isArray(expected.files) || expected.files.length === 0) problems.push("files must be a non-empty list");
  const hasIds = Array.isArray(expected.ruleIds);
  const hasTags = Array.isArray(expected.signals);
  if (hasIds === hasTags) problems.push("it lists ruleIds or signals, exactly one of them");
  if (group === "signals" && !hasTags) problems.push("a signals group lists signals");
  if (group !== "signals" && !hasIds) problems.push("a check group lists ruleIds");
  if (problems.length) return { problem: `${slash(path.relative(DATA_ROOT, file))}: ${problems.join("; ")}` };
  return { expected };
}

// ---- Step: gates ------------------------------------------------------------------------------------------------------------------

function gatesStep() {
  const problems = [];
  if (!fs.existsSync(ruleFile)) return [`no rule file ${slash(path.relative(DATA_ROOT, ruleFile))}`];
  let rules;
  try {
    rules = readRules(ruleFile);
  } catch (e) {
    return [`${ruleRel}: ${e.message}`];
  }
  const asvsIds = new Set(JSON.parse(fs.readFileSync(ASVS_FILE, "utf8")).requirements.map((r) => r.req_id));
  const other = otherRules();
  const fixtures = fixturesOf(ruleFile);
  if (fixtures.length === 0) problems.push(`${ruleRel} has no fixture beside it (same stem, the language's extension)`);
  const fixtureText = fixtures.map((f) => fs.readFileSync(f, "utf8")).join("\n");
  if (/semgrep\.dev/i.test(fs.readFileSync(ruleFile, "utf8"))) problems.push(`${ruleRel} links to the registry`);
  if (rules.length === 0) problems.push(`${ruleRel} has no rule`);

  const seen = new Set();
  const ownFamilies = new Map();
  for (const rule of rules) {
    const id = rule?.id;
    if (typeof id !== "string" || id === "") {
      problems.push("a rule without an id");
      continue;
    }
    const meta = rule.metadata && typeof rule.metadata === "object" ? rule.metadata : {};
    const where = id;
    if (seen.has(id)) problems.push(`${where}: defined twice in the file`);
    seen.add(id);
    if (other.ids.has(id)) problems.push(`${where}: also defined in ${other.ids.get(id)}`);
    if (!id.startsWith(`jgates.${prefix}.`)) problems.push(`${where}: must start with jgates.${prefix}.`);
    if (!/^jgates\.[a-z0-9]+\.[a-z0-9][a-z0-9-]*$/.test(id)) problems.push(`${where}: the name after the prefix is lower-case words joined by -`);
    if (!LISTS.severities.includes(rule.severity)) problems.push(`${where}: severity ${rule.severity} is not one of ${LISTS.severities.join(", ")}`);
    if (typeof rule.message !== "string" || rule.message.trim() === "") problems.push(`${where}: no message`);
    else if (/https?:\/\//.test(rule.message)) problems.push(`${where}: the message carries a link`);
    if (!Array.isArray(rule.languages) || rule.languages.length === 0) problems.push(`${where}: no languages`);
    else if (language === "javascript" && !(rule.languages.includes("javascript") && rule.languages.includes("typescript"))) problems.push(`${where}: a JavaScript rule names javascript and typescript`);
    if (meta.author !== "JGates") problems.push(`${where}: metadata.author must be JGates`);
    const keys = Object.keys(meta).sort();
    for (const key of LISTS.forbiddenMetadata) if (keys.includes(key)) problems.push(`${where}: metadata key ${key} is typical of registry rules`);
    const isSignal = typeof meta.signal === "string" && meta.signal !== "";
    if (Object.hasOwn(meta, "class")) {
      if (meta.class !== "review") problems.push(`${where}: class must be review`);
      if (rule.severity !== "INFO") problems.push(`${where}: a Review rule must have severity INFO`);
      if (isSignal) problems.push(`${where}: a signal rule cannot have class`);
    }
    if (id.endsWith("-by-default") && meta.class !== "review") problems.push(`${where}: a -by-default rule must have class: review`);
    if (group === "signals" && !isSignal) problems.push(`${where}: a signals file holds only signal rules (metadata.signal)`);
    if (group !== "signals" && isSignal) problems.push(`${where}: a signal rule belongs in the ${language}-signals file`);
    if (isSignal) {
      if (!LISTS.signalTags.includes(meta.signal)) problems.push(`${where}: signal ${meta.signal} is not in the closed list`);
      if (rule.severity !== "INFO") problems.push(`${where}: a signal rule is INFO`);
      if (JSON.stringify(keys) !== JSON.stringify([...LISTS.signalMetadata].sort())) problems.push(`${where}: a signal rule carries only ${LISTS.signalMetadata.join(" and ")}, found ${keys.join(", ")}`);
      if (id !== `jgates.${prefix}.uses-${meta.signal}`) problems.push(`${where}: a signal rule is named jgates.${prefix}.uses-${meta.signal}`);
    } else {
      if (!LISTS.categories.includes(meta.category)) problems.push(`${where}: category ${meta.category} is not in the closed list`);
      if (!/^CWE-\d+$/.test(String(meta.cwe ?? ""))) problems.push(`${where}: cwe must look like CWE-79`);
      if (!LISTS.subdimensions.includes(meta.subdimension)) problems.push(`${where}: subdimension ${meta.subdimension} is not in the closed list`);
      if (JSON.stringify(keys.filter((key) => !LISTS.optionalRuleMetadata.includes(key))) !== JSON.stringify([...LISTS.ruleMetadata].sort())) problems.push(`${where}: metadata keys must be ${LISTS.ruleMetadata.join(", ")} with optional ${LISTS.optionalRuleMetadata.join(", ")}, found ${keys.join(", ")}`);
      const reqs = Array.isArray(meta.asvs_requirements) ? meta.asvs_requirements.map(String) : [];
      if (reqs.length === 0) problems.push(`${where}: asvs_requirements is empty or missing`);
      for (const req of reqs) if (!asvsIds.has(req)) problems.push(`${where}: ${req} is not a requirement of ASVS 5.0.0`);
      if (new Set(reqs).size !== reqs.length) problems.push(`${where}: an asvs requirement is listed twice`);
      const family = id.replace(/^jgates\.[^.]+\./, "");
      const kind = `${meta.category} ${meta.cwe}`;
      const known = other.families.get(family);
      if (known && known.kind !== kind) problems.push(`${where}: the family ${family} has another category or CWE than ${known.id}`);
      ownFamilies.set(family, kind);
    }
    const esc = id.replace(/[.]/g, "\\.");
    if (fixtures.length && !new RegExp(`ruleid:\\s*${esc}(?![\\w.-])`).test(fixtureText)) problems.push(`${where}: the fixture has no ruleid: case`);
    if (fixtures.length && !new RegExp(`\\bok:\\s*${esc}(?![\\w.-])`).test(fixtureText)) problems.push(`${where}: the fixture has no ok: case`);
  }

  // The expected files and their twin files.
  const allIds = new Set([...other.ids.keys(), ...seen]);
  for (const lang of twinLanguages) {
    const { expected, problem } = readExpected(lang);
    if (problem) {
      problems.push(problem);
      continue;
    }
    for (const variant of ["vulnerable", "clean"]) {
      for (const file of expected.files) if (!fs.existsSync(path.join(FIXTURES, variant, lang, file))) problems.push(`${variant}/${lang}/${file} does not exist (listed in expected/${lang}/${group}.json)`);
    }
    for (const id of expected.ruleIds ?? []) if (!allIds.has(id)) problems.push(`expected/${lang}/${group}.json: ${id} is not a rule of the pack`);
    for (const t of expected.signals ?? []) if (!seen.has(`jgates.${prefix}.uses-${t}`)) problems.push(`expected/${lang}/${group}.json: signal ${t} has no rule in ${ruleRel}`);
  }
  return problems;
}

// ---- Step: validate and test -------------------------------------------------------------------------------------------------

async function validateStep() {
  const r = await runSemgrep(["--validate", "--config", ruleFile, "--metrics=off", "--disable-version-check", "--quiet"], work);
  return r.status === 0 ? [] : [oneLine(tail(`${r.stdout}\n${r.stderr}`))];
}

async function testStep() {
  // A private copy of the rule file and its fixtures: the test never touches the pack and never sees another file.
  const dir = path.join(work, "rule-test");
  fs.mkdirSync(dir, { recursive: true });
  for (const file of [ruleFile, ...fixturesOf(ruleFile)]) fs.copyFileSync(file, path.join(dir, path.basename(file)));
  const r = await runSemgrep(["--test", "--jobs=1", "--metrics=off", "--disable-version-check", dir], work);
  const text = `${r.stdout}\n${r.stderr}`;
  if (r.status === 0 && /All tests passed/.test(text)) return [];
  return [oneLine(tail(text, 20))];
}

// ---- Step: twins -------------------------------------------------------------------------------------------------------------------

const SIGNAL_ID = /^jgates\.[a-z0-9]+\.uses-([a-z0-9-]+)$/;

function twinWorkspace(variant, lang, expected) {
  const dir = path.join(work, `ws-${variant}-${lang}`);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(FIXTURES, variant, lang);
  for (const file of [...(SUPPORT_FILES[lang] ?? []), ...expected.files]) {
    if (!fs.existsSync(path.join(src, file))) continue;
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.copyFileSync(path.join(src, file), path.join(dir, file));
  }
  return dir;
}

async function scan(dir) {
  // The whole pack is the configuration, so a rule of another file that fires on this twin shows up.
  const r = await runSemgrep(["scan", "--config", RULES, "--json", "--quiet", "--metrics=off", "--disable-version-check", "--no-git-ignore", "--jobs=2", "."], dir);
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    return { problem: `Semgrep gave no JSON (exit ${r.status}): ${oneLine(tail(`${r.stderr}\n${r.stdout}`))}` };
  }
  const norm = (p) => slash(p).replace(/^\.\//, "");
  const results = (doc.results ?? []).map((x) => ({ id: /(jgates\.[a-z0-9]+\.[a-z0-9-]+)$/.exec(String(x.check_id))?.[1] ?? String(x.check_id), file: norm(x.path), line: x.start?.line }));
  const errors = (doc.errors ?? []).filter((e) => e.path && fs.existsSync(path.join(dir, e.path)) && /syntax|parse/i.test(`${e.type ?? ""} ${e.long_msg ?? e.message ?? ""}`)).map((e) => `${norm(e.path)}: ${oneLine(String(e.long_msg ?? e.message ?? e.type))}`);
  // A rule of the pack that Semgrep rejects ("invalid rule") would hide in the errors list.
  const ruleErrors = (doc.errors ?? []).filter((e) => /rule/i.test(String(e.type ?? "")) && /invalid|unknown/i.test(String(e.long_msg ?? e.message ?? e.type))).map((e) => oneLine(String(e.long_msg ?? e.message ?? e.type)));
  return { results, errors, ruleErrors };
}

const sorted = (values) => [...new Set(values)].sort();
const diff = (want, got) => ({ missing: want.filter((x) => !got.includes(x)), extra: got.filter((x) => !want.includes(x)) });

async function twinSteps() {
  const outcome = { vulnerable: [], clean: [] };
  const jobs = [];
  for (const lang of twinLanguages) {
    const { expected } = readExpected(lang);
    if (!expected) continue; // reported by the gates
    const label = twinLanguages.length > 1 ? `${lang}: ` : "";
    jobs.push(
      (async () => {
        const [bad, good] = await Promise.all([scan(twinWorkspace("vulnerable", lang, expected)), scan(twinWorkspace("clean", lang, expected))]);
        for (const [kind, s] of [["vulnerable", bad], ["clean", good]]) {
          if (s.problem) outcome[kind].push(`${label}${s.problem}`);
          else {
            for (const e of s.errors) outcome[kind].push(`${label}twin does not parse: ${e}`);
            for (const e of s.ruleErrors) outcome[kind].push(`${label}${e}`);
          }
        }
        if (!bad.problem) {
          const checks = bad.results.filter((r) => !SIGNAL_ID.test(r.id));
          const tags = sorted(bad.results.map((r) => SIGNAL_ID.exec(r.id)?.[1]).filter(Boolean));
          if (expected.signals !== undefined) {
            const d = diff(sorted(expected.signals), tags);
            if (d.missing.length || d.extra.length) outcome.vulnerable.push(`${label}signal tags differ from the expected file: missing [${d.missing.join(", ")}], unexpected [${d.extra.join(", ")}]`);
            if (checks.length) outcome.vulnerable.push(`${label}a signals group has no finding, found ${sorted(checks.map((r) => r.id)).join(", ")}`);
          } else {
            const d = diff(sorted(expected.ruleIds), sorted(checks.map((r) => r.id)));
            if (d.missing.length || d.extra.length) outcome.vulnerable.push(`${label}ids differ from the expected file: missing [${d.missing.join(", ")}], unexpected [${d.extra.join(", ")}]`);
            const fileDiff = diff(sorted(expected.files.filter((f) => !/(^|\/)Cargo\.toml$/.test(f))), sorted(checks.map((r) => r.file)));
            if (fileDiff.missing.length || fileDiff.extra.length) outcome.vulnerable.push(`${label}files with findings differ from expected files: no finding in [${fileDiff.missing.join(", ")}], findings in [${fileDiff.extra.join(", ")}]`);
          }
        }
        if (!good.problem) {
          const found = good.results.filter((r) => expected.signals === undefined ? !SIGNAL_ID.test(r.id) : true);
          if (found.length) outcome.clean.push(`${label}the clean twin has findings: ${sorted(found.map((r) => `${r.id}@${r.file}:${r.line}`)).slice(0, 8).join(", ")}${found.length > 8 ? ", ..." : ""}`);
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return outcome;
}

// ---- Run ------------------------------------------------------------------------------------------------------------------------------

const report = [];
async function timed(name, fn) {
  const t = Date.now();
  const problems = await fn();
  report.push({ name, problems, took: secs(t) });
  return problems;
}

try {
  const gates = await timed("gates", async () => gatesStep());
  if (gates.length && !fs.existsSync(ruleFile)) {
    for (const p of gates) console.error(`  ${p}`);
    finish(false, `failed at gates: ${gates[0]}`);
  }
  // A rule file the gates cannot read is not worth handing to the engine.
  const readable = (() => {
    try {
      readRules(ruleFile);
      return true;
    } catch {
      return false;
    }
  })();
  let twins = { vulnerable: [], clean: [] };
  if (readable) {
    const t0 = Date.now();
    const [validate, test, twinOut] = await Promise.all([timed("validate", validateStep), timed("test", testStep), twinSteps()]);
    void validate;
    void test;
    twins = twinOut;
    const took = secs(t0);
    report.push({ name: "vulnerable twin", problems: twins.vulnerable, took });
    report.push({ name: "clean twin", problems: twins.clean, took });
  }
  const order = ["gates", "validate", "test", "vulnerable twin", "clean twin"];
  report.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  for (const step of report) {
    if (step.problems.length === 0) console.log(`  ok    ${step.name} (${step.took})`);
    else {
      console.log(`  FAIL  ${step.name} (${step.took})`);
      for (const p of step.problems.slice(0, 12)) console.log(`        - ${p}`);
      if (step.problems.length > 12) console.log(`        - ... ${step.problems.length - 12} more`);
    }
  }
  const failed = report.filter((s) => s.problems.length > 0);
  if (failed.length) finish(false, `failed at ${failed.map((s) => s.name).join(", ")}: ${failed[0].problems[0].slice(0, 200)}`);
  const ruleCount = readRules(ruleFile).length;
  finish(true, `${ruleRel} (${ruleCount} rule${ruleCount === 1 ? "" : "s"}): gates, validate, test, vulnerable twin, clean twin${twinLanguages.length > 1 ? ` [${twinLanguages.join(" + ")}]` : ""}`);
} catch (error) {
  console.error(error?.stack ?? String(error));
  finish(false, `crashed: ${error?.message ?? error}`);
} finally {
  cleanup();
}
