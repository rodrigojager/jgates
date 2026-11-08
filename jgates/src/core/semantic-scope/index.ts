// The Semantic scope engine (V2): full (recommended), selected and incremental scopes resolved before any model work,
// with a deterministic impact/context proposal, a host file-access guard, the reuse of compatible prior evidence and
// the disclosure of inherited coverage. `jgates semantic plan --scope ...`, the run service (core/semantic) and the
// API preview (server/routes/semantic-scope.ts) use only this module.
export * from "./types.js";
export * from "./controls.js";
export * from "./resolve.js";
export * from "./access.js";
export * from "./ledger.js";
export * from "./run.js";
export { buildImportGraph, extractImports, resolveImport, type ImportGraph } from "./imports.js";
export { categoriesOf } from "./classify.js";
