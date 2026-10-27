import fs from "node:fs";
import path from "node:path";
import type { GateResult, ProviderResponse } from "./types.js";

export function writeReports(
  result: GateResult,
  providerResponses: ProviderResponse[],
  outputDir: string,
): { jsonPath: string; markdownPath: string; rawPath: string } {
  fs.mkdirSync(outputDir, { recursive: true });
  const jsonPath = path.join(outputDir, "semantic-result.json");
  const markdownPath = path.join(outputDir, "semantic-result.md");
  const rawPath = path.join(outputDir, "raw-provider-output.json");

  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, renderMarkdown(result), "utf8");
  fs.writeFileSync(
    rawPath,
    `${JSON.stringify(providerResponses.map((response) => response.raw), null, 2)}\n`,
    "utf8",
  );
  return { jsonPath, markdownPath, rawPath };
}

export function renderMarkdown(result: GateResult): string {
  const findingsBySeverity = (severity: string) =>
    result.findings.filter((finding) => finding.severity === severity);

  return `# Quality Gate Result

Gate: Complementary Semantic Review
Status: ${result.status}
Score: ${result.score}
Threshold: ${result.threshold}
Deterministic Summary Used: ${result.deterministicSummaryUsed ? "Yes" : "No"}
Objective Source: ${result.objectiveSource}
Changes Reviewed: ${result.changesReviewed}

## Hard Blockers
${result.hardBlockers.length ? result.hardBlockers.map((item) => `- ${item}`).join("\n") : "- Nenhum"}

## Score Breakdown
| Categoria | Peso | Nota | Observacoes |
|---|---:|---:|---|
${result.scoreBreakdown
  .map((item) => `| ${item.category} | ${item.weight} | ${item.score} | ${item.observations} |`)
  .join("\n")}

## Commands Executed
| Command | Result | Purpose |
|---|---|---|
${result.commandsExecuted
  .map((item) => `| \`${escapePipes(item.command)}\` | ${escapePipes(item.result)} | ${escapePipes(item.purpose)} |`)
  .join("\n")}

## Findings
### Blocking
${renderFindings(findingsBySeverity("blocking"))}

### Important
${renderFindings(findingsBySeverity("important"))}

### Suggestions
${renderFindings(findingsBySeverity("suggestion"))}

### Nits
${renderFindings(findingsBySeverity("nit"))}

## Required Fix Plan
${result.requiredFixPlan.length ? result.requiredFixPlan.map((item, index) => `${index + 1}. ${item}`).join("\n") : "1. Nenhum"}

## Re-run Commands
\`\`\`bash
${result.rerunCommands.join("\n")}
\`\`\`

## Approval Notes
${result.approvalNotes}

## Residual Risks
${result.residualRisks.length ? result.residualRisks.map((item) => `- ${item}`).join("\n") : "- Nenhum"}

## Context Warnings
${result.contextWarnings.length ? result.contextWarnings.map((item) => `- ${item}`).join("\n") : "- Nenhum"}
`;
}

function renderFindings(findings: GateResult["findings"]): string {
  if (findings.length === 0) {
    return "- Nenhum";
  }
  return findings
    .map((finding) => {
      const location = finding.path ? `${finding.path}${finding.line ? `:${finding.line}` : ""}` : "sem local";
      const fix = finding.requiredFix ? ` Correcao: ${finding.requiredFix}` : "";
      return `- [${finding.category}] ${location} ${finding.message}${fix}`;
    })
    .join("\n");
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

