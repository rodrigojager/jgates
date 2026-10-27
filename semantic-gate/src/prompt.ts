import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SemanticGateError } from "./errors.js";
import type { GitReviewContext, ObjectiveInput, PromptOverride, PromptSettings, SemanticGateConfig } from "./types.js";

export interface PromptChunk {
  label: string;
  prompt: string;
}

// The texts of the prompts live in files of templates/ (the code only assembles them): the system prompt and the
// review rubric. A project may replace or extend each one (config `prompts`); the output contract (the JSON the result
// parser reads) is not a file and is not customizable: it always closes the prompt, so the answer stays parseable.

export type PromptKind = "system" | "review";

/** Default prompt files, by kind, inside templates/. */
export const PROMPT_FILES: Readonly<Record<PromptKind, string>> = {
  system: "system-prompt.md",
  review: "semantic-review-skill.md",
};

/** Closes a customized system prompt, so a replaced one still asks for the parseable answer. */
export const SYSTEM_FORMAT_LINE = "Return valid JSON only. Do not include Markdown fences.";

export interface PromptPartInfo {
  /** default: the packaged file as is; custom: the project replaced or extended it. */
  source: "default" | "custom";
  mode: "default" | PromptOverride["mode"];
  /** The project file (absolute) when custom; null for the packaged default. */
  file: string | null;
  /** sha256 of the effective text of this part. */
  sha256: string;
}

export interface EffectivePrompts {
  system: string;
  review: string;
  info: {
    /** sha256 of the effective prompts: the hashes of the system prompt and of the review rubric, together. */
    sha256: string;
    system: PromptPartInfo;
    review: PromptPartInfo;
  };
}

/** Folder of the packaged prompt files. */
export function templatesDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates");
}

/** Absolute paths of the packaged prompt files. */
export function defaultPromptPaths(): Record<PromptKind, string> {
  const dir = templatesDir();
  return { system: path.join(dir, PROMPT_FILES.system), review: path.join(dir, PROMPT_FILES.review) };
}

/** The prompts in effect: the packaged files, replaced or extended by the configured project files. */
export function resolvePrompts(settings: PromptSettings | undefined = undefined): EffectivePrompts {
  const defaults = defaultPromptPaths();
  const system = resolvePart("system", readPromptFile(defaults.system, "Missing semantic review template"), settings?.system);
  const review = resolvePart("review", readPromptFile(defaults.review, "Missing semantic review template"), settings?.review);
  return {
    system: system.text,
    review: review.text,
    info: { sha256: sha256(JSON.stringify({ system: system.info.sha256, review: review.info.sha256 })), system: system.info, review: review.info },
  };
}

function resolvePart(kind: PromptKind, base: string, override: PromptOverride | undefined): { text: string; info: PromptPartInfo } {
  // The packaged system prompt is one block of lines (its trailing newline is not part of it); the rubric goes as is.
  const packaged = kind === "system" ? base.replace(/\s+$/, "") : base;
  if (!override) {
    return { text: packaged, info: { source: "default", mode: "default", file: null, sha256: sha256(packaged) } };
  }
  if (override.mode !== "replace" && override.mode !== "append") {
    throw new SemanticGateError(`prompts.${kind}.mode must be replace or append.`, "usage");
  }
  const file = path.resolve(override.file);
  const custom = readPromptFile(file, `Missing prompts.${kind} file`);
  let text = override.mode === "replace" ? custom : `${packaged.replace(/\s+$/, "")}\n\n${custom}`;
  if (kind === "system") {
    text = `${text.replace(/\s+$/, "")}\n${SYSTEM_FORMAT_LINE}`;
  }
  return { text, info: { source: "custom", mode: override.mode, file, sha256: sha256(text) } };
}

function readPromptFile(file: string, missing: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new SemanticGateError(`${missing}: ${file}`, missing.startsWith("Missing semantic") ? "context" : "usage");
  }
  if (!stat.isFile()) {
    throw new SemanticGateError(`${missing}: ${file} is not a file`, "usage");
  }
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/**
 * Copies the packaged prompt files into `dir` for the user to edit. An existing file is never overwritten without
 * `force`: then nothing is written and the error names the files that exist.
 */
export function exportPrompts(dir: string, options: { force?: boolean } = {}): string[] {
  const target = path.resolve(dir);
  const sources = defaultPromptPaths();
  const pairs = (Object.keys(PROMPT_FILES) as PromptKind[]).map((kind) => ({ from: sources[kind], to: path.join(target, PROMPT_FILES[kind]) }));
  const existing = pairs.filter((p) => fs.existsSync(p.to)).map((p) => p.to);
  if (existing.length > 0 && !options.force) {
    throw new SemanticGateError(`Refusing to overwrite ${existing.join(", ")}; pass --force to replace.`, "usage");
  }
  fs.mkdirSync(target, { recursive: true });
  for (const pair of pairs) {
    fs.copyFileSync(pair.from, pair.to);
  }
  return pairs.map((p) => p.to);
}

/** The system prompt in effect (the packaged one when no prompts are given). */
export function systemPrompt(prompts: EffectivePrompts = resolvePrompts()): string {
  return prompts.system;
}

export function buildPromptChunks(
  objective: ObjectiveInput,
  context: GitReviewContext,
  config: SemanticGateConfig,
  prompts: EffectivePrompts = resolvePrompts(config.prompts),
): PromptChunk[] {
  const shared = buildSharedHeader(objective, context, config, prompts);
  if (shared.length > config.maxContextChars) {
    throw new SemanticGateError(
      `Objective and repository metadata exceed maxContextChars (${shared.length} > ${config.maxContextChars}).`,
      "context",
    );
  }

  const fileBlocks = context.changedFiles.map(formatFileBlock);
  const allFiles = fileBlocks.join("\n\n");
  const singlePrompt = `${shared}\n\n## File Context\n\n${allFiles}\n\n${finalInstruction(config)}`;

  if (config.contextStrategy !== "chunked" && singlePrompt.length <= config.maxContextChars) {
    return [{ label: "full-review", prompt: singlePrompt }];
  }
  if (config.contextStrategy === "single" && singlePrompt.length > config.maxContextChars) {
    throw new SemanticGateError(
      `Context exceeds maxContextChars (${singlePrompt.length} > ${config.maxContextChars}). Use a larger model or contextStrategy=chunked.`,
      "context",
    );
  }

  const chunks: PromptChunk[] = [];
  let currentBlocks: string[] = [];
  let currentLength = shared.length + finalInstruction(config).length + 40;

  for (const block of fileBlocks) {
    const blockLength = block.length + 2;
    if (currentBlocks.length > 0 && currentLength + blockLength > config.maxContextChars) {
      chunks.push(chunkPrompt(shared, currentBlocks, chunks.length + 1, config));
      currentBlocks = [];
      currentLength = shared.length + finalInstruction(config).length + 40;
    }
    if (blockLength + shared.length > config.maxContextChars) {
      throw new SemanticGateError(
        `A single file context block exceeds maxContextChars. Lower maxFileChars/maxDiffChars or use a larger model.`,
        "context",
      );
    }
    currentBlocks.push(block);
    currentLength += blockLength;
  }

  if (currentBlocks.length > 0 || chunks.length === 0) {
    chunks.push(chunkPrompt(shared, currentBlocks, chunks.length + 1, config));
  }
  return chunks;
}

export function buildSynthesisPrompt(
  objective: ObjectiveInput,
  context: GitReviewContext,
  partialResults: unknown[],
  config: SemanticGateConfig,
  prompts: EffectivePrompts = resolvePrompts(config.prompts),
): string {
  return [
    buildSharedHeader(objective, context, config, prompts),
    "## Partial Semantic Reviews",
      "The following JSON objects are partial semantic reviews over disjoint file-context chunks. Synthesize a final gate result for the requested scope.",
    JSON.stringify(partialResults, null, 2),
    finalInstruction(config),
  ].join("\n\n");
}

function chunkPrompt(
  shared: string,
  blocks: string[],
  index: number,
  config: SemanticGateConfig,
): PromptChunk {
  return {
    label: `chunk-${index}`,
    prompt: `${shared}\n\n## File Context Chunk ${index}\n\n${blocks.join("\n\n")}\n\n${finalInstruction(config)}`,
  };
}

function buildSharedHeader(
  objective: ObjectiveInput,
  context: GitReviewContext,
  config: SemanticGateConfig,
  prompts: EffectivePrompts,
): string {
  return [
    "## Semantic Review Rubric",
    prompts.review,
    "## Objective",
    `Source: ${objective.source}`,
    objective.text,
    "## Repository Context",
    `Repo root: ${context.repoRoot}`,
    `Scope: ${context.scope}`,
    `Configured paths: ${context.paths.length ? context.paths.join(", ") : "(none)"}`,
    `Configured excludes: ${context.excludes.length ? context.excludes.join(", ") : "(none)"}`,
    `Configured includes: ${context.includes.length ? context.includes.join(", ") : "(none)"}`,
    `Ignore files used: ${context.ignoreFiles.length ? context.ignoreFiles.join(", ") : "(none)"}`,
    `Threshold: ${config.threshold}`,
    "Deterministic summary used: false",
    "## Git Status",
    fenced(context.statusShort || "(clean status output)"),
    "## Diff Stats",
    fenced(
      [
        context.rangeDiffStat ? `Range diff stat:\n${context.rangeDiffStat}` : undefined,
        context.diffStat ? `Unstaged diff stat:\n${context.diffStat}` : undefined,
        context.stagedDiffStat ? `Staged diff stat:\n${context.stagedDiffStat}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n") || "(no diff stat output)",
    ),
    "## Context Warnings",
    context.warnings.length ? context.warnings.map((warning) => `- ${warning}`).join("\n") : "- None",
  ].join("\n\n");
}

function formatFileBlock(file: GitReviewContext["changedFiles"][number]): string {
  const parts = [
    `### ${file.path}`,
    `Change kinds: ${file.changeKinds.join(", ") || "unknown"}`,
  ];
  if (file.skippedReason) {
    parts.push(`Skipped content reason: ${file.skippedReason}`);
  }
  if (file.diff) {
    parts.push("Unstaged/range diff:", fenced(file.diff));
  }
  if (file.stagedDiff) {
    parts.push("Staged diff:", fenced(file.stagedDiff));
  }
  if (file.content !== undefined) {
    parts.push("Current file content:", fenced(file.content));
  }
  if (file.truncated) {
    parts.push("Context note: this file or diff was truncated by configured safety limits.");
  }
  return parts.join("\n\n");
}

function finalInstruction(config: SemanticGateConfig): string {
  return [
    "## Output Contract",
    "Return one JSON object matching this shape:",
    fenced(
      JSON.stringify(
        {
          gate: "semantic",
          status: "APPROVED | NEEDS_CHANGES | REJECTED",
          score: "0-100",
          threshold: config.threshold,
          deterministicSummaryUsed: false,
          objectiveSource: "file:path | stdin | inferred from diff",
          changesReviewed: "short description",
          hardBlockers: ["string"],
          scoreBreakdown: [
            { category: "functional", weight: 25, score: 0, observations: "string" },
            { category: "tests", weight: 20, score: 0, observations: "string" },
            { category: "security", weight: 20, score: 0, observations: "string" },
            { category: "maintainability", weight: 15, score: 0, observations: "string" },
            { category: "architecture", weight: 10, score: 0, observations: "string" },
            { category: "performance", weight: 10, score: 0, observations: "string" },
          ],
          commandsExecuted: [{ command: "git status --short", result: "ok", purpose: "identify changed files" }],
          findings: [
            {
              severity: "blocking | important | suggestion | nit",
              category: "functional | tests | security | maintainability | architecture | performance | ai-generated-code-risk",
              path: "relative/path",
              line: 1,
              message: "concrete issue",
              requiredFix: "concrete fix",
            },
          ],
          requiredFixPlan: ["step"],
          rerunCommands: [
            "semantic-gate run --scope changed --objective-file <file> --json",
            "quality-gate . --scope changed --json --no-interactive",
          ],
          approvalNotes: "string",
          residualRisks: ["string"],
          contextWarnings: ["string"],
        },
        null,
        2,
      ),
    ),
    "Do not include deterministic findings unless they have a separate semantic consequence. Do not output Markdown.",
  ].join("\n\n");
}

function fenced(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
