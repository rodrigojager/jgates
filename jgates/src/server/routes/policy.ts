// The CI policy screen: the fingerprint of the policy folder this server edits, the files that enter it, the ready CI
// snippets (variables and job) and a dry plan of the policy on a local project. Nothing here writes: the policy is
// edited by the same routes as a project, and the test on a project only builds a plan.
import fs from "node:fs";
import path from "node:path";
import { BuiltinError } from "../../builtin/index.js";
import { checkPolicyLocation, readPolicyBundle, type PolicyError, type PolicyBundle } from "../../core/policy/index.js";
import { buildPlan } from "../../core/plan/index.js";
import { translator } from "../../i18n/index.js";
import { HttpError } from "../http.js";
import { modeOf } from "../policy-mode.js";
import type { RouteDefinition, ServerContext } from "../types.js";

const t = translator("policy");

/** Name of the variable that carries the fingerprint of the policy, and the one that points at the policy checkout. */
export const POLICY_HASH_VARIABLE = "JGATES_POLICY_SHA256";
export const POLICY_DIR_VARIABLE = "JGATES_POLICY_DIR";

/** The command the CI job runs (the policy comes from JGATES_POLICY_DIR, the hash from JGATES_POLICY_SHA256). */
export const CI_COMMAND = 'jgates ci --policy "$JGATES_POLICY_DIR" --sarif jgates.sarif';

/** Where the job gets JGates: the repository, never a registry (replace the URL by your organization's copy). */
export const INSTALL_SOURCE = "git+https://github.com/rodrigojager/jgates";

/**
 * The install command for a folder. npm cannot install a git dependency with --global (it links the bins to a
 * temporary clone it then deletes), so the job installs into a folder outside the project and puts its bins on PATH.
 */
export function installCommand(prefix: string): string {
  return `npm install --prefix "${prefix}" ${INSTALL_SOURCE}`;
}

function policyFailure(error: PolicyError): HttpError {
  const key = `policy_err_${error.code.toLowerCase()}`;
  const params = { path: error.path ?? "" };
  const message = t(key, params);
  return new HttpError(422, error.code, message === key ? error.message : message, t(`${key}_fix`, params) === `${key}_fix` ? null : t(`${key}_fix`, params));
}

/** The snippet for GitHub Actions. The policy is a second checkout beside the project, never inside it. */
export function githubSnippet(sha256: string): string {
  return [
    `# .github/workflows/jgates.yml (in the project repository)`,
    `# Store the fingerprint in a protected repository variable: ${POLICY_HASH_VARIABLE} = ${sha256}`,
    `name: JGates`,
    `on: [pull_request]`,
    `permissions:`,
    `  contents: read`,
    `  security-events: write`,
    `jobs:`,
    `  jgates:`,
    `    runs-on: ubuntu-latest`,
    `    env:`,
    `      ${POLICY_DIR_VARIABLE}: \${{ github.workspace }}/policy`,
    `      ${POLICY_HASH_VARIABLE}: \${{ vars.${POLICY_HASH_VARIABLE} }}`,
    `    steps:`,
    `      - uses: actions/checkout@v4`,
    `        with:`,
    `          path: project`,
    `          fetch-depth: 0`,
    `      - uses: actions/checkout@v4`,
    `        with:`,
    `          repository: <organization>/<policy-repository>`,
    `          ref: main`,
    `          path: policy`,
    `          token: \${{ secrets.POLICY_REPOSITORY_TOKEN }}`,
    `      - uses: actions/setup-node@v4`,
    `        with:`,
    `          node-version: 22`,
    `      # Install JGates from the repository (or from a tarball your organization stores), never from a registry.`,
    `      # npm cannot install a git dependency with --global: install into a folder and put its bins on PATH.`,
    `      - run: |`,
    `          ${installCommand("$RUNNER_TEMP/jgates")}`,
    `          echo "$RUNNER_TEMP/jgates/node_modules/.bin" >> "$GITHUB_PATH"`,
    `      - run: ${CI_COMMAND}`,
    `        working-directory: project`,
    `      - uses: github/codeql-action/upload-sarif@v3`,
    `        if: always()`,
    `        with:`,
    `          sarif_file: project/jgates.sarif`,
    ``,
  ].join("\n");
}

/** The snippet for GitLab CI. The policy is cloned outside the project folder. */
export function gitlabSnippet(sha256: string): string {
  return [
    `# .gitlab-ci.yml (in the project repository)`,
    `# Store the fingerprint in a protected CI/CD variable: ${POLICY_HASH_VARIABLE} = ${sha256}`,
    `jgates:`,
    `  stage: test`,
    `  image: node:22`,
    `  variables:`,
    `    GIT_DEPTH: "0"`,
    `    # Outside $CI_PROJECT_DIR: a policy inside the analyzed project is refused (POLICY_INSIDE_PROJECT).`,
    `    ${POLICY_DIR_VARIABLE}: "$CI_BUILDS_DIR/jgates-policy-$CI_JOB_ID"`,
    `    # JGates itself is installed outside $CI_PROJECT_DIR too, so its files never enter the analysis.`,
    `    JGATES_INSTALL_DIR: "$CI_BUILDS_DIR/jgates-install-$CI_JOB_ID"`,
    `  script:`,
    `    - git clone --depth 1 --branch main "https://gitlab-ci-token:$CI_JOB_TOKEN@$CI_SERVER_HOST/<group>/<policy-repository>.git" "$${POLICY_DIR_VARIABLE}"`,
    `    # Install JGates from the repository (or from a tarball your organization stores), never from a registry.`,
    `    # npm cannot install a git dependency with --global: install into a folder and put its bins on PATH.`,
    `    - ${installCommand("$JGATES_INSTALL_DIR")}`,
    `    - export PATH="$JGATES_INSTALL_DIR/node_modules/.bin:$PATH"`,
    `    - ${CI_COMMAND}`,
    `  artifacts:`,
    `    when: always`,
    `    paths:`,
    `      - jgates.sarif`,
    ``,
  ].join("\n");
}

function describeBundle(bundle: PolicyBundle) {
  return {
    sha256: bundle.sha256,
    count: bundle.files.length,
    files: bundle.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })),
    variables: [
      { name: POLICY_HASH_VARIABLE, value: bundle.sha256 },
      { name: POLICY_DIR_VARIABLE, value: null },
    ],
    command: CI_COMMAND,
    snippets: { github: githubSnippet(bundle.sha256), gitlab: gitlabSnippet(bundle.sha256) },
  };
}

function requirePolicyMode(server: ServerContext): void {
  if (!server.policyMode) throw new HttpError(409, "POLICY_MODE_REQUIRED", t("policy_mode_required"), t("policy_mode_required_fix"));
}

const LIST_LIMIT = 200;

export const routes: RouteDefinition[] = [
  {
    // What the screen shows. Outside the policy mode it only says so (and whether the project is governed).
    method: "GET",
    path: "/api/policy",
    handler({ server }) {
      const { mode, governed } = modeOf();
      if (!server.policyMode) return { status: 200, json: { schemaVersion: 1, status: "OK", editing: false, mode, governed } };
      const read = readPolicyBundle(server.projectDir);
      if (!read.ok) {
        const error = policyFailure(read.error);
        return { status: 200, json: { schemaVersion: 1, status: "OK", editing: true, name: path.basename(server.projectDir), path: server.projectDir, problem: { code: error.code, message: error.message, fix: error.fix } } };
      }
      return { status: 200, json: { schemaVersion: 1, status: "OK", editing: true, name: path.basename(server.projectDir), path: server.projectDir, ...describeBundle(read.bundle) } };
    },
  },
  {
    // "Testar contra um projeto": the plan `jgates ci` would make for the project with this policy. It builds the plan
    // and reports it; it writes nothing in the project, in the policy or in the data folder.
    method: "POST",
    path: "/api/policy/test",
    body: {
      type: "object",
      properties: { project: { type: "string", minLength: 1, maxLength: 4096 } },
      required: ["project"],
      additionalProperties: false,
    },
    timeoutMs: 120_000,
    handler({ body, server }) {
      requirePolicyMode(server);
      const requested = (body as { project: string }).project;
      if (!path.isAbsolute(requested)) throw new HttpError(400, "PROJECT_NOT_ABSOLUTE", t("policy_project_not_absolute"), t("policy_project_not_absolute_fix"));
      const project = path.resolve(requested);
      let isDir = false;
      try {
        isDir = fs.statSync(project).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new HttpError(404, "PROJECT_NOT_FOUND", t("policy_project_not_found", { path: project }), t("policy_project_not_found_fix"));
      const location = checkPolicyLocation(server.projectDir, project);
      if (location) throw policyFailure(location);

      let result;
      try {
        result = buildPlan(project, { configDir: server.projectDir, compare: false, version: server.version, home: server.home });
      } catch (error) {
        if (error instanceof BuiltinError) throw new HttpError(422, "BUILTIN_INVALID", error.message);
        throw error;
      }
      if (!result.ok) {
        const { code, message, fix } = result.error;
        throw new HttpError(422, code, message, fix ?? null, { errors: result.errors });
      }
      const plan = result.plan;
      const willRun = plan.groups.willRun.map((i) => ({ id: i.id, label: i.label, category: i.category, tool: i.tool }));
      const off = plan.groups.notApplicableOrDisabled.length;
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          status: plan.blocked ? "BLOCKED" : "OK",
          project,
          planHash: plan.planHash,
          profile: plan.profile ? { id: plan.profile.id, label: plan.profile.label } : null,
          approvable: plan.approvable,
          blockers: plan.blockers.map((b) => ({ code: b.code, message: b.message })),
          warnings: plan.warnings.map((w) => ({ code: w.code, message: w.message })),
          components: plan.components.slice(0, LIST_LIMIT).map((c) => ({ id: c.id, root: c.root, language: c.language, framework: c.framework, status: c.status })),
          willRun: willRun.slice(0, LIST_LIMIT),
          willRunCount: willRun.length,
          offCount: off,
          uncoveredCount: plan.groups.uncoveredRequirements.length,
          configFiles: plan.inputs.configFiles.slice(0, LIST_LIMIT).map((f) => f.file),
        },
      };
    },
  },
];
