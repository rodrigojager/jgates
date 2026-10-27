import fs from "node:fs";
import { SemanticGateError } from "./errors.js";
import { readStdin } from "./stdin.js";
import type { CliOptions, ObjectiveInput } from "./types.js";

export async function readObjective(options: CliOptions): Promise<ObjectiveInput> {
  if (options.objectiveFile && options.objectiveStdin) {
    throw new SemanticGateError("Use either --objective-file or --objective-stdin, not both.", "usage");
  }
  if (options.objectiveFile) {
    const filePath = String(options.objectiveFile);
    if (!fs.existsSync(filePath)) {
      throw new SemanticGateError(`Objective file not found: ${filePath}`, "context");
    }
    return {
      text: fs.readFileSync(filePath, "utf8"),
      source: `file:${filePath}`,
    };
  }
  if (options.objectiveStdin) {
    return {
      text: await readStdin(),
      source: "stdin",
    };
  }
  throw new SemanticGateError("Missing objective input. Use --objective-file <path> or --objective-stdin.", "usage");
}

