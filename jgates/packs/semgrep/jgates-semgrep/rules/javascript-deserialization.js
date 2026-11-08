const serialize = require("node-serialize");
const yaml = require("js-yaml");

function load(blob, text) {
  // ruleid: jgates.js.unsafe-deserialization
  serialize.unserialize(blob);
  // ruleid: jgates.js.unsafe-deserialization
  yaml.load(text, { schema: yaml.DEFAULT_FULL_SCHEMA });
  // ok: jgates.js.unsafe-deserialization
  JSON.parse(text);
  // ok: jgates.js.unsafe-deserialization
  yaml.load(text);
}
