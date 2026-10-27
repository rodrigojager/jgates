// Installing what the project's checks need: the classification of each missing item (assess), the recipes and their
// previews (recipes), the system commands for Docker (system), the JGates Python environment (paths) and the
// conversation on the terminal (interact). Used by `jgates doctor` and by the run that offers to install.
export * from "./paths.js";
export * from "./system.js";
export * from "./recipes.js";
export * from "./assess.js";
export * from "./interact.js";
