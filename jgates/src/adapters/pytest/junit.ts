// pytest reads its JUnit XML (--junitxml, junit_family=xunit2) through the shared core reader.
export { readJunit as parseJunit, caseFile, type JunitCase, type JunitReport } from "../../core/evidence/junit-read.js";
