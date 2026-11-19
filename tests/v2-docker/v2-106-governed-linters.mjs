import assert from "node:assert/strict";
import test from "node:test";
import { docker } from "../../jgates/tests/docker/dev-docker.mjs";
import { assertGovernedLinters, image } from "../v2/fixtures/governed-linters.mjs";

test("V2-106 (real engine): governed descriptor tools report findings, suppressions, and network exclusions", { timeout: 600_000 }, (t) => {
  assert.equal(docker(["image", "inspect", image]).code, 0, `${image} is required`);
  assertGovernedLinters(t, docker);
});
