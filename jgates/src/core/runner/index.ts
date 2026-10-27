// Local runner: one process per ExecutionSpec (no shell, allowlisted
// environment, limits, process-tree cancellation), the preflight of a step, and the executor that runs the steps of
// a run in dependency order, fail-closed. The spec and result shapes are what the adapters depend on.
export {
  DEFAULT_ENV_ALLOWLIST,
  DEFAULT_KILL_GRACE_MS,
  DEFAULT_MAX_LOG_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  buildEnv,
  runSpec,
  substituteTokens,
  type ExecutionResult,
  type ExecutionSpec,
  type RunnerOptions,
} from "./process.js";
export {
  CONTAINER_OUTPUT,
  CONTAINER_WORKSPACE,
  ContainerSpecError,
  DEFAULT_CONTAINER_LIMITS,
  DOCKER_CLIENT_ENV,
  buildContainerArgs,
  containerName,
  defaultContainerUser,
  runContainer,
  toContainerPath,
  type ContainerFacts,
  type ContainerResult,
  type ContainerSpec,
} from "./container.js";
export { BoundedCapture, BoundedLog, TRUNCATION_MARKER } from "./log-sink.js";
export { preflight, resolveExecutable, type PreflightCode, type PreflightProblem, type PreflightSpec } from "./preflight.js";
export { currentScope, runInScope, type ExecutionScope, type ProcessRecord } from "./scope.js";
export { isAlive, listDescendants, processTable, signalTree, treeStopper, type TreeStopper } from "./tree.js";
export {
  executeSteps,
  failClosed,
  mergeOutputs,
  stageSatisfied,
  stepSucceeded,
  tripsFailFast,
  type ExecuteStepsOptions,
  type ExecuteStepsResult,
  type RunStep,
  type StepReport,
  type StepStatus,
} from "./executor.js";
