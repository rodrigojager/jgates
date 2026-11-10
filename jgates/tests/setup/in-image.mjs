// Loaded by the node test runs (`node --import`): JGates runs in these tests as it runs inside the JGates tools image
// (in-image mode, PLAN-architecture.md section 2). Steps then run natively, so the test doubles a test names
// (JGATES_RUFF, JGATES_PYTHON, JGATES_SEMGREP...) are honoured, and the image's tools are the ones the package's
// mirror of image.json lists (release/image-tools.json). No test reaches a real container engine by accident: the
// default engine client is a name that does not exist (ENGINE_NOT_INSTALLED).
//
// A test of the container mode (the default outside the image) gives JGates JGATES_IMAGE_JSON="" and the fake engine
// (tests/docker/fake-docker.cjs) in JGATES_CONTAINER_RUNTIME.
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.JGATES_IMAGE_JSON ??= path.resolve(here, "..", "..", "release", "image-tools.json");
process.env.JGATES_CONTAINER_RUNTIME ??= "jgates-test-no-engine";
