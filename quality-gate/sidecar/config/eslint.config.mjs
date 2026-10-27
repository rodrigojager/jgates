import { createRequire } from "node:module";

// Resolve from MegaLinter's root-owned dependency tree, never from a project
// checkout or the current working directory.
const require = createRequire("/node-deps/package.json");
const js = require("@eslint/js");

export default [
  {
    ignores: ["**/.quality/**", "**/dist/**", "**/node_modules/**"],
  },
  {
    ...js.configs.recommended,
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        AbortController: "readonly",
        Blob: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        global: "readonly",
        globalThis: "readonly",
        module: "readonly",
        navigator: "readonly",
        process: "readonly",
        queueMicrotask: "readonly",
        require: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
      },
    },
    rules: js.configs.recommended.rules,
  },
];
