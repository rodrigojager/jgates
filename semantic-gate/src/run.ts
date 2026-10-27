import path from "node:path";
import { collectGitReviewContext } from "./context.js";
import { callProvider } from "./providers.js";
import { buildPromptChunks, buildSynthesisPrompt, resolvePrompts, systemPrompt } from "./prompt.js";
import { writeReports } from "./report.js";
import { mergeLocalFallbackResult, normalizeGateResult, parseProviderResult } from "./result.js";
import type { GateResult, ObjectiveInput, ProviderResponse, SemanticGateConfig } from "./types.js";

export interface RunSemanticGateOptions {
  cwd: string;
  config: SemanticGateConfig;
  objective: ObjectiveInput;
}

export async function runSemanticGate(options: RunSemanticGateOptions): Promise<{
  result: GateResult;
  reports?: { jsonPath: string; markdownPath: string; rawPath: string };
}> {
  // The prompt files are read first: a missing project prompt fails before any git or provider work.
  const prompts = resolvePrompts(options.config.prompts);
  const gitContext = await collectGitReviewContext(options.cwd, options.config);
  if (gitContext.changedFiles.length === 0) {
    const emptyResult: GateResult = {
      gate: "semantic",
      status: "APPROVED",
      score: 100,
      threshold: options.config.threshold,
      deterministicSummaryUsed: false,
      objectiveSource: options.objective.source,
      changesReviewed: `No files matched scope=${options.config.scope}.`,
      scoreAppliesTo: scoreAppliesToForScope(options.config.scope),
      hardBlockers: [],
      scoreBreakdown: [
        { category: "functional", weight: 25, score: 100, observations: "No files were reviewed in the selected scope." },
        { category: "tests", weight: 20, score: 100, observations: "No files were reviewed in the selected scope." },
        { category: "security", weight: 20, score: 100, observations: "No files were reviewed in the selected scope." },
        { category: "maintainability", weight: 15, score: 100, observations: "No files were reviewed in the selected scope." },
        { category: "architecture", weight: 10, score: 100, observations: "No files were reviewed in the selected scope." },
        { category: "performance", weight: 10, score: 100, observations: "No files were reviewed in the selected scope." },
      ],
      commandsExecuted: gitContext.commandsExecuted,
      findings: [],
      requiredFixPlan: [],
      rerunCommands: [
        "semantic-gate run --scope changed --objective-file <objective-file> --json",
        "quality-gate . --scope changed --json --no-interactive",
      ],
      approvalNotes: "No files were matched for this scope. Review was skipped.",
      residualRisks: [],
      contextWarnings: gitContext.warnings.length
        ? [`No files matched scope=${options.config.scope}.`, ...gitContext.warnings]
        : [`No files matched scope=${options.config.scope}.`],
      provider: options.config.provider ?? "unconfigured",
    };
    if (options.config.writeReports) {
      const providerResponses: ProviderResponse[] = [{
        text: JSON.stringify({
          status: emptyResult.status,
          score: emptyResult.score,
          findings: [],
          requiredFixPlan: emptyResult.requiredFixPlan,
          hardBlockers: emptyResult.hardBlockers,
          scoreBreakdown: emptyResult.scoreBreakdown,
        }),
        raw: { status: emptyResult.status },
      }];
      return { result: emptyResult, reports: writeReports(emptyResult, providerResponses, path.resolve(gitContext.repoRoot, options.config.outputDir)) };
    }
    return { result: emptyResult };
  }

  const chunks = buildPromptChunks(options.objective, gitContext, options.config, prompts);
  const providerResponses: ProviderResponse[] = [];
  const partialResults: GateResult[] = [];
  const provider = options.config.provider ?? "unconfigured";

  for (const chunk of chunks) {
    const response = await callProvider({
      prompt: chunk.prompt,
      system: systemPrompt(prompts),
      config: options.config,
      cwd: options.cwd,
      chunkLabel: chunk.label,
    });
    providerResponses.push(response);
    partialResults.push(
      normalizeGateResult(parseProviderResult(response.text), optionalModelContext({
        config: options.config,
        objective: options.objective,
        gitContext,
        provider,
      }, options.config.model)),
    );
  }

  let result: GateResult;
  if (partialResults.length === 1) {
    result = partialResults[0]!;
  } else {
    try {
      const synthesis = await callProvider({
        prompt: buildSynthesisPrompt(options.objective, gitContext, partialResults, options.config, prompts),
        system: systemPrompt(prompts),
        config: options.config,
        cwd: options.cwd,
        chunkLabel: "final-synthesis",
      });
      providerResponses.push(synthesis);
      result = normalizeGateResult(parseProviderResult(synthesis.text), optionalModelContext({
        config: options.config,
        objective: options.objective,
        gitContext,
        provider,
      }, options.config.model));
    } catch {
      result = mergeLocalFallbackResult(partialResults, optionalModelContext({
        config: options.config,
        objective: options.objective,
        gitContext,
        provider,
      }, options.config.model));
    }
  }

  result.scoreAppliesTo = scoreAppliesToForScope(options.config.scope);
  const outputDir = path.resolve(gitContext.repoRoot, options.config.outputDir);
  if (options.config.writeReports) {
    return { result, reports: writeReports(result, providerResponses, outputDir) };
  }
  return { result };
}

function scoreAppliesToForScope(scope: SemanticGateConfig["scope"]): GateResult["scoreAppliesTo"] {
  return scope === "full" ? "entire-project" : scope === "paths" ? "selected-paths" : "changed-files";
}

function optionalModelContext<T extends { model?: string }>(context: Omit<T, "model">, model: string | undefined): T {
  return (model === undefined ? context : { ...context, model }) as T;
}
