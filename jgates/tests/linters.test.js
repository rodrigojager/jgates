import test, { after } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { BUILTIN_FIXTURES, DIST, linterHarness } from "./setup/linter-harness.mjs";

// The per-tool tests of the linter engine: one named test per descriptor of src/builtin/linters, titled
// "<id>: the bad fixture gives the expected findings and the clean twin none [proves: <id>#<capability>, ...]" (the
// support matrix cites these titles). A tool slice runs only its own: --test-name-pattern "^<id>: ". Each test replays
// the tool's real output (tests/fixtures/linters/<id>/recorded/) through the engine; see tests/setup/linter-harness.mjs.
// A descriptor without its fixtures, recordings, expected findings or texts fails its test: a tool cannot be half-added.

const engine = await import(pathToFileURL(path.join(DIST, "adapters", "linter", "index.js")).href);
const harness = await linterHarness();
after(() => harness.cleanup());

// The descriptors of the package only (never the extra folder of a developer's environment).
const builtin = engine.loadLinters({ ...process.env, JGATES_LINTERS_EXTRA_DIR: "" });

for (const { descriptor } of builtin) {
  test(engine.linterTestTitle(descriptor), async () => {
    await harness.prove(descriptor, BUILTIN_FIXTURES);
  });
}
