// If this file were imported it would create executed.marker next to itself (codecs-js.test.js checks it never happens).
import fs from "node:fs";
import js from "@eslint/js";
import globals from "globals";

fs.writeFileSync(new URL("./executed.marker", import.meta.url), "executed");

const strict = process.env.CI ? "error" : "warn";

export default [
  js.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"], // sources
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.node },
    },
    rules: {
      semi: ["error", "always"],
      quotes: ['error', 'single'],
      "no-console": strict,
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  {
    ignores: ["dist/**", "coverage/**"],
  },
];
