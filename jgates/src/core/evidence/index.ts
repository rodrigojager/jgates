// Shared readers of the report formats tools write (SARIF, JUnit, Checkstyle): one parser, tested once, used by the
// adapters that know the format (CodeQL, pytest, Playwright) and by generic-command for tools a user registers.
export { readSarif, severityBySecurityScore, type SarifFinding, type SarifOptions, type SarifRead } from "./sarif-read.js";
export { readJunit, caseFile, type JunitCase, type JunitReport } from "./junit-read.js";
export { readCheckstyle, type CheckstyleFinding, type CheckstyleReport } from "./checkstyle-read.js";

/** `origin` of a finding that came from a tool the user registered ("ferramenta própria"). */
export const OWN_TOOL_ORIGIN = "own-tool";
