// Preparing what the project's checks need (container-first: the engine, the tools image, an instance's data; never a
// tool on the host): the classification of each missing item (assess), the recipes and their previews (recipes), the
// system commands for Docker (system) and the conversation on the terminal (interact). Used by `jgates doctor` and by
// the run that offers to prepare.
export * from "./system.js";
export * from "./recipes.js";
export * from "./assess.js";
export * from "./interact.js";
