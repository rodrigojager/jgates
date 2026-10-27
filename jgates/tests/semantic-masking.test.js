import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Configurable masking of the semantic-gate context (extensions.semantic-gate.masking and include) and the external
// PII tools of .jgates/pii.yml (core/mask-tools). The review context is a stub and the provider is a fake that records
// the prompt it would send: no git, no model, no tokens. The prompt itself is built by the semantic-gate package.
// Every sensitive-looking literal is assembled from parts at run time, so the repository gates do not flag this source.

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(here, "..", "dist");
const load = (rel) => import(pathToFileURL(path.join(DIST, rel)).href);
const { runSemanticReview, readSemanticState, loadGate } = await load("adapters/semantic-gate/index.js");
const { maskText, defaultMaskRules } = await load("adapters/semantic-gate/mask.js");
const { serializeFile, deserializeFile } = await load("adapters/semantic-gate/masking.js");
const tools = await load("core/mask-tools/index.js");

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const join = (...parts) => parts.join("");

const VALUES = {
  cpf: join("529", ".982", ".247", "-25"),
  email: join("ana.souza", "@", "example", ".org"),
  ip: ["10", "20", "30", "40"].join("."),
  employee: join("EMP-", "204", "518"),
  corp: join("CORP-", "7731"),
  secretValue: join("s3cr", "etValue", "42xyz"),
};
const SECRET_LINE = `${join("api", "_key")} = "${VALUES.secretValue}"`;
const PRIVATE_KEY = [join("-----BEGIN ", "RSA PRIVATE", " KEY-----"), "MIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu", join("-----END ", "RSA PRIVATE", " KEY-----")].join("\n");

const APPROVED = JSON.stringify({ status: "APPROVED", score: 100, findings: [], hardBlockers: [], requiredFixPlan: [], approvalNotes: "fake" });

function contextOf(files) {
  return {
    repoRoot: "/repo",
    scope: "changed",
    paths: [],
    excludes: [],
    includes: [],
    ignoreFiles: [],
    statusShort: files.map((f) => ` M ${f.path}`).join("\n"),
    diffStat: "",
    stagedDiffStat: "",
    commandsExecuted: [],
    changedFiles: files.map((f) => ({ changeKinds: ["unstaged"], ...f })),
    warnings: [],
  };
}

/** The fake external tool: one script, the behavior chosen by its first argument. */
function writeToolScript(dir) {
  const script = path.join(dir, "fake-pii-tool.mjs");
  fs.writeFileSync(
    script,
    `import fs from "node:fs";
import path from "node:path";
const [mode, log, from = "CORP-\\\\d{4}", label = "corp-id"] = process.argv.slice(2);
const dir = process.env.JGATES_MASK_DIR;
const list = fs.readFileSync(process.env.JGATES_MASK_FILES, "utf8").split("\\n").filter(Boolean);
const status = (s) => process.stdout.write("working...\\n" + JSON.stringify({ jgatesMask: 1, status: "ok", detected: false, changed: false, ...s }) + "\\n");
if (log) fs.appendFileSync(log, JSON.stringify({ mode, cwdIsDir: process.cwd() === fs.realpathSync(dir), listOutside: !path.resolve(process.env.JGATES_MASK_FILES).startsWith(path.resolve(dir) + path.sep), env: process.env.JGATES_MASK_MODE, list, texts: list.map((f) => fs.readFileSync(path.join(dir, f), "utf8")) }) + "\\n");
const first = path.join(dir, list[0]);
switch (mode) {
  case "mask": {
    let n = 0;
    const re = new RegExp(from, "g");
    const touched = [];
    for (const f of list) {
      const p = path.join(dir, f);
      const text = fs.readFileSync(p, "utf8");
      const out = text.replace(re, () => (n++, "[MASKED:" + label + "]"));
      if (out !== text) fs.writeFileSync(p, out), touched.push(f);
    }
    status({ detected: n > 0, changed: n > 0, counts: n > 0 ? { [label]: n } : {}, files: touched });
    break;
  }
  case "fail": process.stderr.write("tool crashed"); process.exit(2);
  case "error": status({ status: "error", message: "license expired" }); break;
  case "sleep": await new Promise((r) => setTimeout(r, 20000)); break;
  case "nostatus": process.stdout.write("all good\\n"); break;
  case "invalid": process.stdout.write(JSON.stringify({ jgatesMask: 1, status: "ok", changed: false }) + "\\n"); break;
  case "liar-unchanged": fs.appendFileSync(first, "x"); status({ detected: true, changed: false }); break;
  case "liar-changed": status({ detected: true, changed: true, counts: { x: 1 } }); break;
  case "create": fs.writeFileSync(path.join(dir, "new.txt"), "x"); status({}); break;
  case "delete": fs.rmSync(first); status({}); break;
  case "unresolved": status({ detected: true, changed: false, counts: { [label]: 1 } }); break;
  case "markers": fs.writeFileSync(first, fs.readFileSync(first, "utf8").replaceAll("@@jgates-mask-part", "@@gone")); status({ detected: true, changed: true, counts: { x: 1 } }); break;
  case "touch-other": fs.appendFileSync(path.join(dir, "b.txt"), "y"); status({ detected: true, changed: true, counts: { x: 1 } }); break;
  case "link": fs.symlinkSync(first, path.join(dir, "link.txt")); status({}); break;
  case "noop": status({}); break;
  default: process.exit(9);
}
`,
  );
  return script;
}

/** A workspace with jgates.yml (the semantic block given as YAML lines) and, optionally, .jgates/pii.yml. */
function project({ semantic = [], pii = null } = {}) {
  const dir = tmp("jgates-masking-");
  const aux = tmp("jgates-masking-aux-");
  const script = writeToolScript(aux);
  const log = path.join(aux, "tool.log");
  // The tool that hangs gets one second; the others have room for a slow machine.
  const toolLine = (args) => `{ command: ${JSON.stringify(process.execPath)}, args: ${JSON.stringify([script, ...args])}, timeoutSeconds: ${args[0] === "sleep" ? 1 : 30} }`;
  fs.writeFileSync(path.join(dir, "jgates.yml"), ["schemaVersion: 1", "extensions:", "  semantic-gate:", "    provider: command", "    model: fake-model", ...semantic.map((l) => `    ${l}`), ""].join("\n"));
  if (pii) {
    fs.mkdirSync(path.join(dir, ".jgates"));
    const lines = ["schemaVersion: 1", "tools:", ...Object.entries(pii).map(([id, args]) => `  ${id}: ${typeof args === "string" ? args : toolLine([...args.slice(0, 1), log, ...args.slice(1)])}`)];
    fs.writeFileSync(path.join(dir, ".jgates", "pii.yml"), `${lines.join("\n")}\n`);
  }
  const prompts = [];
  return {
    dir,
    log,
    prompts,
    toolRuns: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
    async review(files) {
      const real = await loadGate();
      const gate = { ...real, collectGitReviewContext: async () => contextOf(files) };
      const callProvider = async (request) => {
        prompts.push(request.prompt);
        return { text: APPROVED, raw: null };
      };
      return runSemanticReview(dir, { env: process.env }, { loadGate: async () => gate, callProvider });
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(aux, { recursive: true, force: true });
    },
  };
}

const sampleFile = (text, file = "src/app.js") => ({ path: file, diff: `+${text}\n` });

async function withProject(options, fn) {
  const p = project(options);
  try {
    await fn(p);
  } finally {
    p.cleanup();
  }
}

// ---- entities, patterns and secrets --------------------------------------------------------------------------------------

test("cpf is masked by default and turning it off leaves the CPF in the prompt", async () => {
  await withProject({}, async (p) => {
    const r = await p.review([sampleFile(`const doc = "${VALUES.cpf}";`)]);
    assert.equal(r.state, "completed", JSON.stringify(r));
    assert.ok(!p.prompts[0].includes(VALUES.cpf));
    assert.ok(p.prompts[0].includes("[MASKED:cpf]"));
    assert.equal(r.context.masked.cpf, 1);
  });
  await withProject({ semantic: ["masking:", "  pii:", "    cpf: false"] }, async (p) => {
    const r = await p.review([sampleFile(`const doc = "${VALUES.cpf}";`)]);
    assert.equal(r.state, "completed");
    assert.ok(p.prompts[0].includes(VALUES.cpf), "with cpf: false the value reaches the provider");
    assert.equal(r.context.masked.cpf, undefined, "a disabled entity has no count");
  });
});

test("e-mail is masked by default; ip-address only with ip-address: true", async () => {
  const text = `contact ${VALUES.email} at ${VALUES.ip}`;
  await withProject({}, async (p) => {
    const r = await p.review([sampleFile(text)]);
    assert.ok(!p.prompts[0].includes(VALUES.email));
    assert.ok(p.prompts[0].includes("[MASKED:email]"));
    assert.ok(p.prompts[0].includes(VALUES.ip), "ip-address is off by default");
    assert.equal(r.context.masked.email, 1);
  });
  await withProject({ semantic: ["masking:", "  pii:", "    ip-address: true"] }, async (p) => {
    const r = await p.review([sampleFile(text)]);
    assert.ok(!p.prompts[0].includes(VALUES.ip));
    assert.ok(p.prompts[0].includes("[MASKED:ip-address]"));
    assert.equal(r.context.masked["ip-address"], 1);
  });
});

test("a project pattern becomes [MASKED:<label>] and counts under its label", async () => {
  await withProject({ semantic: ["masking:", "  patterns:", '    - { id: employee-id, regex: "EMP-\\\\d{6}", label: employee }'] }, async (p) => {
    const r = await p.review([sampleFile(`owner: ${VALUES.employee}`)]);
    assert.equal(r.state, "completed", JSON.stringify(r));
    assert.ok(!p.prompts[0].includes(VALUES.employee));
    assert.ok(p.prompts[0].includes("[MASKED:employee]"));
    assert.equal(r.context.masked.employee, 1);
    assert.equal(r.context.masked.total, 1);
  });
});

test("secrets stay masked even with every entity off", async () => {
  const off = ["cpf", "cnpj", "credit-card", "phone", "email", "ip-address"].map((e) => `    ${e}: false`);
  await withProject({ semantic: ["masking:", "  pii:", ...off] }, async (p) => {
    const r = await p.review([sampleFile(`${SECRET_LINE}\n${PRIVATE_KEY}\nmail ${VALUES.email}`), { path: ".env", content: "TOKEN=abcdef123456" }]);
    assert.equal(r.state, "completed");
    const sent = p.prompts[0];
    assert.ok(!sent.includes(VALUES.secretValue));
    assert.ok(!sent.includes("MIIBOgIBAAJBAKj34"));
    assert.ok(sent.includes("[MASKED:secret]") && sent.includes("[MASKED:private-key]"));
    assert.ok(sent.includes(VALUES.email), "the e-mail entity is off");
    assert.equal(r.context.masked.secret, 2);
    assert.deepEqual(r.context.excluded, [{ path: ".env", reason: "sensitive-file" }]);
    assert.ok(!sent.includes("abcdef123456"));
  });
});

test("e-mail and IP shapes: positive, negative and ambiguous cases", () => {
  const all = { ...defaultMaskRules(), entities: { ...defaultMaskRules().entities, "ip-address": true } };
  const masked = (text) => {
    const counts = {};
    return { out: maskText(text, counts, all), counts };
  };
  const at = "@";
  // e-mail: positives
  for (const email of [join("ana", at, "example.org"), join("first.last+tag", at, "mail.example.com.br"), join("x_y", at, "sub-domain.example.io")]) {
    const { out, counts } = masked(`to: <${email}>.`);
    assert.equal(out, "to: <[MASKED:email]>.", email);
    assert.equal(counts.email, 1);
  }
  // e-mail: negatives (scoped packages, versions, decorators, retina assets, hosts without a top-level label)
  for (const text of [join(at, "scope/pkg"), join("lodash", at, "4.17.21"), join(at, "Component()"), join("icon", at, "2x.png"), join("user", at, "localhost"), join("a", at, "b.c0m")]) {
    assert.equal(masked(text).out, text, text);
  }
  // e-mail: ambiguous, masked on purpose (an SSH remote has the shape of an address)
  assert.equal(masked(join("git", at, "github.com:org/repo.git")).out, "[MASKED:email]:org/repo.git");
  // IPv4: positives
  for (const ip of ["192.168.0.1", "10.0.0.255", "8.8.8.8"]) assert.equal(masked(`host ${ip}.`).out, "host [MASKED:ip-address].", ip);
  // IPv4: negatives (octet over 255, longer dotted versions, glued to a word)
  for (const text of ["999.1.1.1", "1.2.3.4.5", "v1.2.3.4", "300.400.500.600"]) assert.equal(masked(text).out, text, text);
  // IPv4: ambiguous, masked on purpose (a four-part version has the shape of an address)
  assert.equal(masked("version 1.2.3.4").out, "version [MASKED:ip-address]");
  // IPv6: positives, and scope operators without digits are kept
  for (const ip of ["2001:db8::1", "::1", "fe80::1ff:fe23:4567:890a", "2001:0db8:0000:0000:0000:ff00:0042:8329"]) assert.equal(masked(`addr ${ip}`).out, "addr [MASKED:ip-address]", ip);
  for (const text of ["std::vector", "cafe::bad", "Foo::bar()", "12:30:45"]) assert.equal(masked(text).out, text, text);
  // Off by default: no IP mask without the switch.
  assert.equal(maskText("8.8.8.8", {}), "8.8.8.8");
});

// ---- include and onMatch -------------------------------------------------------------------------------------------------

test("include: only the listed paths enter the context; excludes and secret files still leave", async () => {
  await withProject({ semantic: ['include: ["src/**"]', 'excludes: ["src/generated/**"]'] }, async (p) => {
    const r = await p.review([
      sampleFile("one", "src/a.js"),
      sampleFile("two", "src/generated/b.js"),
      sampleFile("three", "docs/readme.md"),
      { path: "src/.env", content: "PASSWORD=hunter22" },
    ]);
    assert.equal(r.state, "completed", JSON.stringify(r));
    assert.equal(r.context.files, 1);
    const reasons = Object.fromEntries(r.context.excluded.map((e) => [e.path, e.reason]));
    assert.deepEqual(reasons, { "src/generated/b.js": "excluded", "docs/readme.md": "not-included", "src/.env": "sensitive-file" });
    const sent = p.prompts[0];
    assert.ok(sent.includes("src/a.js"));
    for (const text of ["+two", "+three", "hunter22"]) assert.ok(!sent.includes(text), text);
  });
});

test("onMatch block: a finding sends nothing and says why; without a finding the review goes on", async () => {
  await withProject({ semantic: ["masking:", "  onMatch: block"] }, async (p) => {
    const r = await p.review([sampleFile(`mail ${VALUES.email}`)]);
    assert.equal(r.state, "blocked");
    assert.equal(r.code, "MASKING_BLOCKED");
    assert.match(r.reason, /onMatch is block/);
    assert.equal(r.context.masked.email, 1);
    assert.equal(r.calls, 0);
    assert.equal(p.prompts.length, 0, "the provider was not called");
    assert.ok(!JSON.stringify(r).includes(VALUES.email));
  });
  await withProject({ semantic: ["masking:", "  onMatch: block"] }, async (p) => {
    const r = await p.review([sampleFile("nothing sensitive here")]);
    assert.equal(r.state, "completed");
    assert.equal(p.prompts.length, 1);
  });
  // A tool that detects something also blocks.
  await withProject({ semantic: ["masking:", "  onMatch: block", "  tools: [corp]"], pii: { corp: ["mask"] } }, async (p) => {
    const r = await p.review([sampleFile(`id ${VALUES.corp}`)]);
    assert.equal(r.state, "blocked");
    assert.equal(r.context.masked["corp-id"], 1);
    assert.equal(p.prompts.length, 0);
  });
});

// ---- configuration errors ---------------------------------------------------------------------------------------------------

test("an invalid regex, a repeated id and an unknown tool are configuration errors with the field path", async () => {
  await withProject(
    {
      semantic: [
        "masking:",
        "  patterns:",
        '    - { id: bad, regex: "EMP-(\\\\d{6}" }',
        '    - { id: twice, regex: "A\\\\d" }',
        '    - { id: twice, regex: "B\\\\d" }',
        "  tools: [missing-tool]",
      ],
      pii: { known: ["noop"] },
    },
    async (p) => {
      const state = readSemanticState(p.dir);
      assert.equal(state.state, "invalid");
      const text = state.problems.join("\n");
      assert.match(text, /extensions\.semantic-gate\.masking\.patterns\[0\]\.regex is not a valid regular expression/);
      assert.match(text, /extensions\.semantic-gate\.masking\.patterns\[2\]\.id repeats the id "twice"/);
      assert.match(text, /extensions\.semantic-gate\.masking\.tools\[0\]: the tool "missing-tool" is not defined in \.jgates\/pii\.yml/);
      const r = await p.review([sampleFile("x")]);
      assert.equal(r.state, "not-configured");
      assert.match(r.reason, /masking\.patterns\[0\]\.regex/);
      assert.equal(p.prompts.length, 0);
    },
  );
  await withProject({ semantic: ["masking:", "  tools: [broken]"], pii: { broken: "{ args: [1] }" } }, async (p) => {
    const text = readSemanticState(p.dir).problems.join("\n");
    assert.match(text, /\.jgates\/pii\.yml: tools\.broken\.command must be a non-empty string/);
    assert.match(text, /\.jgates\/pii\.yml: tools\.broken\.args must be a list of strings/);
  });
  await withProject({ semantic: ["masking:", "  pii: { email: maybe, ssn: true }", "  onMatch: warn", '  patterns: [{ id: empty, regex: "x*" }]'] }, async (p) => {
    const text = readSemanticState(p.dir).problems.join("\n");
    assert.match(text, /masking\.pii\.email must be true or false/);
    assert.match(text, /masking\.pii\.ssn is not a known entity/);
    assert.match(text, /masking\.onMatch must be mask or block/);
    assert.match(text, /masking\.patterns\[0\]\.regex matches an empty text/);
  });
});

test("pii.yml with tools passes the schema of config validate; a wrong field is refused with its path", async () => {
  const { validateDocument } = await load("core/config/load/index.js");
  const ok = validateDocument("pii", { schemaVersion: 1, tools: { "corp-dlp": { command: "corp-dlp", args: ["scan"], timeoutSeconds: 30, passEnv: ["CORP_DLP_TOKEN"] } } }, ".jgates/pii.yml");
  assert.deepEqual(ok, []);
  const bad = validateDocument("pii", { schemaVersion: 1, tools: { "corp-dlp": { args: ["scan"], timeout: 3 } } }, ".jgates/pii.yml");
  assert.ok(bad.length > 0);
  assert.ok(bad.some((d) => d.path.startsWith("tools.corp-dlp")), JSON.stringify(bad));
});

// ---- the external tools in context mode ----------------------------------------------------------------------------------

test("the tool's edits of the copy reach the prompt and its counts enter by label", async () => {
  await withProject({ semantic: ["masking:", "  tools: [corp]"], pii: { corp: ["mask"] } }, async (p) => {
    const r = await p.review([sampleFile(`id ${VALUES.corp} doc ${VALUES.cpf}`), { path: "lib/two.txt", content: `again ${VALUES.corp}` }]);
    assert.equal(r.state, "completed", JSON.stringify(r));
    const sent = p.prompts[0];
    assert.ok(!sent.includes(VALUES.corp));
    assert.equal((sent.match(/\[MASKED:corp-id\]/g) ?? []).length, 2);
    assert.equal(r.context.masked["corp-id"], 2);
    assert.equal(r.context.masked.cpf, 1);
    assert.deepEqual(r.context.tools.map((t) => [t.id, t.ok, t.detected, t.changed]), [["corp", true, true, true]]);
    const [run] = p.toolRuns();
    assert.equal(run.env, "context");
    assert.ok(run.cwdIsDir, "the tool runs in JGATES_MASK_DIR");
    assert.ok(run.listOutside, "the file list is outside the copy");
    assert.deepEqual(run.list, ["lib/two.txt", "src/app.js"]);
    // The copy already carries the internal masks: the tool never sees the CPF.
    assert.ok(run.texts.every((t) => !t.includes(VALUES.cpf)));
    assert.ok(run.texts.some((t) => t.includes("[MASKED:cpf]")));
  });
});

test("several tools run in order, each on the result of the previous one", async () => {
  await withProject({ semantic: ["masking:", "  tools: [first, second]"], pii: { first: ["mask", "CORP-\\d{4}", "stage"], second: ["mask", "\\[MASKED:stage\\]", "final"] } }, async (p) => {
    const r = await p.review([sampleFile(`id ${VALUES.corp}`)]);
    assert.equal(r.state, "completed", JSON.stringify(r));
    assert.ok(p.prompts[0].includes("[MASKED:final]"));
    assert.ok(!p.prompts[0].includes("[MASKED:stage]"));
    assert.deepEqual(r.context.tools.map((t) => t.id), ["first", "second"]);
  });
});

test("a file with several parts keeps them apart through the tool", () => {
  const file = { path: "a.js", content: "C", diff: "D", stagedDiff: "S" };
  const s = serializeFile(file);
  assert.deepEqual(s.fields, ["content", "diff", "stagedDiff"]);
  assert.deepEqual(deserializeFile(s.text, s.fields), { content: "C", diff: "D", stagedDiff: "S" });
  assert.equal(deserializeFile(s.text.replace("@@jgates-mask-part diff@@", "@@x@@"), s.fields), null);
  assert.equal(serializeFile({ path: "b.bin", changeKinds: [] }), null);
});

const FAILURES = [
  ["fail", "MASKING_COMMAND_FAILED", /exited with code 2/],
  ["error", "MASKING_COMMAND_FAILED", /reported an error: license expired/],
  ["sleep", "MASKING_COMMAND_FAILED", /no answer within 1 s/],
  ["nostatus", "MASKING_COMMAND_FAILED", /no status line/],
  ["invalid", "MASKING_COMMAND_FAILED", /status line is invalid/],
  ["liar-unchanged", "MASKING_COMMAND_FAILED", /inconsistent status: the status says not changed/],
  ["liar-changed", "MASKING_COMMAND_FAILED", /inconsistent status: the status says changed but no file changed/],
  ["create", "MASKING_COMMAND_FAILED", /created 1 file/],
  ["delete", "MASKING_COMMAND_FAILED", /removed 1 file/],
  ["markers", "MASKING_COMMAND_FAILED", /part markers/],
  ["unresolved", "MASKING_UNRESOLVED", /detected sensitive data and changed nothing/],
];

for (const [mode, code, reason] of FAILURES) {
  test(`a tool that fails closed (${mode}) keeps the provider uncalled with ${code}`, async () => {
    await withProject({ semantic: ["masking:", "  tools: [corp]"], pii: { corp: [mode] } }, async (p) => {
      const file = mode === "markers" ? { path: "src/app.js", content: `x ${VALUES.corp}`, diff: "+y" } : sampleFile(`id ${VALUES.corp}`);
      const r = await p.review([file]);
      assert.equal(r.state, "unavailable", JSON.stringify(r));
      assert.equal(r.code, code);
      assert.match(r.reason, reason);
      assert.match(r.reason, /nothing was sent/);
      assert.equal(r.calls, 0);
      assert.equal(p.prompts.length, 0, "the provider was not called");
      assert.ok(!JSON.stringify(r).includes(VALUES.corp));
      assert.ok(!r.reason.includes("tool crashed"), "stderr of the tool is not in the result");
    });
  });
}

test("a tool command that does not exist fails closed", async () => {
  await withProject({ semantic: ["masking:", "  tools: [ghost]"], pii: { ghost: "{ command: jgates-no-such-pii-tool-xyz }" } }, async (p) => {
    const r = await p.review([sampleFile("x")]);
    assert.equal(r.code, "MASKING_COMMAND_FAILED");
    assert.match(r.reason, /was not found/);
    assert.equal(p.prompts.length, 0);
  });
});

// ---- the core module (shared with pii check/fix) ---------------------------------------------------------------------

function coreTool(mode, extra = []) {
  const aux = tmp("jgates-mask-core-");
  const script = writeToolScript(aux);
  return { def: { id: "t", command: process.execPath, args: [script, mode, "", ...extra], timeoutSeconds: 5, passEnv: [] }, cleanup: () => fs.rmSync(aux, { recursive: true, force: true }) };
}

async function runCore(mode, { files, toolMode = "context", entries } = {}) {
  const tool = coreTool(mode);
  const ws = tools.createMaskWorkspace(entries ?? [{ path: "a.txt", content: `x ${VALUES.corp}` }, { path: "b.txt", content: "plain" }]);
  try {
    const outcome = await tools.runMaskTool(tool.def, ws, { mode: toolMode, ...(files ? { files } : {}) });
    return { outcome, texts: ws.files.map((f) => ws.readText(f)) };
  } finally {
    ws.cleanup();
    tool.cleanup();
    assert.ok(!fs.existsSync(ws.dir), "the copy is removed");
  }
}

test("core: a file outside the list changed by the tool fails closed", async () => {
  const { outcome } = await runCore("touch-other", { files: ["a.txt"] });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "MASKING_COMMAND_FAILED");
  assert.match(outcome.reason, /outside the list/);
});

test("core: a link in the copy fails closed", { skip: process.platform === "win32" ? "symbolic links need privileges on Windows" : false }, async () => {
  const { outcome } = await runCore("link");
  assert.equal(outcome.ok, false);
  assert.match(outcome.reason, /link/);
});

test("core: check mode allows no change, and a detection without change is its normal answer", async () => {
  const changed = await runCore("mask", { toolMode: "check" });
  assert.equal(changed.outcome.ok, false);
  assert.match(changed.outcome.reason, /check mode allows no change/);
  const found = await runCore("unresolved", { toolMode: "check" });
  assert.equal(found.outcome.ok, true, JSON.stringify(found.outcome));
  assert.equal(found.outcome.status.detected, true);
  assert.deepEqual(found.outcome.changedFiles, []);
  // In fix mode a detection without change is unresolved, as in context mode.
  const fix = await runCore("unresolved", { toolMode: "fix" });
  assert.equal(fix.outcome.code, "MASKING_UNRESOLVED");
  const fixed = await runCore("mask", { toolMode: "fix" });
  assert.equal(fixed.outcome.ok, true);
  assert.deepEqual(fixed.outcome.changedFiles, ["a.txt"]);
  assert.ok(fixed.texts[0].includes("[MASKED:corp-id]"));
});

test("core: the copy refuses unsafe paths and the status schema is published", () => {
  for (const bad of ["../x", "/abs", "a/../b", "a//b", ""]) assert.throws(() => tools.createMaskWorkspace([{ path: bad, content: "x" }]), /unsafe path/);
  assert.ok(fs.existsSync(tools.maskStatusSchemaPath()));
  const schema = JSON.parse(fs.readFileSync(tools.maskStatusSchemaPath(), "utf8"));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.required, ["jgatesMask", "status", "detected", "changed"]);
  const ok = tools.parseMaskStatus('log line\n{"jgatesMask":1,"status":"ok","detected":true,"changed":true,"counts":{"corp-id":2},"files":["a.txt"],"message":"done"}\n');
  assert.equal(ok.status.counts["corp-id"], 2);
  for (const bad of ['{"jgatesMask":2,"status":"ok","detected":false,"changed":false}', '{"jgatesMask":1,"status":"ok","detected":false,"changed":false,"extra":1}', '{"jgatesMask":1,"status":"done","detected":false,"changed":false}', '{"jgatesMask":1,"status":"ok","detected":false,"changed":false,"counts":{"x":-1}}']) {
    assert.match(tools.parseMaskStatus(bad).error, /invalid/, bad);
  }
  assert.match(tools.parseMaskStatus("").error, /no status line/);
});

test("core: readMaskTools reads the definitions with defaults", () => {
  const dir = tmp("jgates-mask-defs-");
  try {
    fs.mkdirSync(path.join(dir, ".jgates"));
    fs.writeFileSync(path.join(dir, ".jgates", "pii.yml"), "schemaVersion: 1\ntools:\n  corp-dlp:\n    command: corp-dlp\n  local:\n    command: node\n    args: [\"{configDir}/tools/adapter.mjs\"]\n  Bad_Id:\n    command: x\n");
    const file = tools.readMaskTools(dir);
    assert.deepEqual(file.tools.get("corp-dlp"), { id: "corp-dlp", command: "corp-dlp", args: [], timeoutSeconds: 60, passEnv: [] });
    assert.ok(file.problems.some((p) => p.includes("tools.Bad_Id is not a valid tool id")));
    assert.deepEqual(file.tools.get("local").args, [`${path.resolve(dir)}/tools/adapter.mjs`]);
    assert.deepEqual(tools.readMaskTools(tmp("jgates-mask-none-")).tools.size, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
