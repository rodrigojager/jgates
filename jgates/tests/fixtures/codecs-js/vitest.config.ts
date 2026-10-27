// If this file were imported it would create executed.marker next to itself (codecs-js.test.js checks it never happens).
import fs from "node:fs";
import { defineConfig } from "vitest/config";

fs.writeFileSync(new URL("./executed.marker", import.meta.url), "executed");

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      thresholds: { lines: 80, functions: 80 },
    },
    setupFiles: ["./test/setup.ts"],
  } satisfies Record<string, unknown>,
});
