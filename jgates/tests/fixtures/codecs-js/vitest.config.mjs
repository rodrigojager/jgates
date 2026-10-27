import base from "./vitest.shared.mjs";
import { defineConfig, mergeConfig } from "vitest/config";

// Everything effective here depends on code (import, mergeConfig, a function): nothing is projectable.
export default defineConfig((env) =>
  mergeConfig(base, {
    test: { include: env.mode === "ci" ? ["**/*.test.ts"] : ["src/**/*.test.ts"] },
  }),
);
