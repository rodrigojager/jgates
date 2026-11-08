# Insecure defaults (adapted for the JGates bounded executor)

Adapted from Trail of Bits, `plugins/insecure-defaults/README.md`, `commands/audit.md` and the phase prompts of
`workflows/audit.js` (https://github.com/trailofbits/skills, commit e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff), licensed
CC BY-SA 4.0. The category corpora in `categories/` are the upstream `references/<category>.md` and `.json` files,
unchanged. This adaptation is licensed CC BY-SA 4.0 as well; see `../NOTICE.md` for what changed and why.

<!-- block:objective -->
Find insecure default configuration that a running deployment really uses: values taken when configuration is absent
(a lookup with a fallback) and insecure values written unconditionally, in the categories fallback secrets, default
credentials, fail-open security switches, permissive access and debug or introspection leakage. A candidate counts only
when the insecure value is the one that runs and it reaches a security decision. Never quote a credential or secret
value: name the setting and the location.
<!-- /block -->

<!-- block:recon -->
Reconnaissance (upstream Recon). Classify the scope and profile the stack: languages and frameworks, how configuration
is read, and the deployment manifests in scope (container files, compose files, infrastructure templates, environment
examples). Find the project's own configuration wrappers (a get_setting("X", "default") helper, a config module) and
say whether each can return a default. The host already ran the generic seed patterns of every category over the
readable files and lists where they matched; seeds are a floor, not the search. For each category derive the patterns
this stack needs (framework keys, language idioms such as ENV.fetch, System.getProperty(k, d), ${VAR:-default}, and
manifest formats). A category whose derived list stays empty only looked for generic idioms and is a coverage gap.
<!-- /block -->

<!-- block:sweep -->
Sweep (upstream Discover). One sweep per category, using its seed and derived patterns (search_files) and reading every
file you report. Sweeps collect and do not judge: report each candidate location with its category and its shape.
- configurable: a lookup with a fallback; a bug only if the application runs with the fallback. env.get("K", "x") runs
  with "x"; env["K"] fails instead, which is fine.
- unconditional: no configuration anywhere, insecure as written. A missing variable is never grounds to drop one.
The same line may be a candidate of two categories; each is judged separately. Report every category as searched (seed
and derived patterns, files scanned) or pending with the reason. The category corpora decide what to report: read the
Report when / Skip when line of a category before filing its candidates.
<!-- /block -->

<!-- block:verify -->
Verification of one candidate (upstream Verify), in a fresh context that did not find it. Read the category's corpus
given below first: it draws the line between report-this and skip-this, with worked vulnerable and secure pairs. Your
default stance is that the candidate is refuted: a pattern sweep produced it and most matches are not vulnerabilities.
Work these steps in order and stop at the first one that settles it, recording which step decided it:
1. Is the file reachable in production? Dead code, a branch only taken under a development flag, a script never
   packaged: refuted.
2. Is the insecure value the one that runs? Configurable: trace what happens when the configuration is absent;
   anything that stops the process (a raising lookup, a startup validator, a schema rejecting missing values) is
   fail-secure and refutes it; booting with the literal is fail-open. Unconditional: this step cannot refute it.
3. Is the value actually insecure? The Skip when line is the rule. For a configurable candidate the insecure state must
   be the unconfigured state; for an unconditional one judge the value as written.
4. Does it reach a security decision? Trace it to its sink and cite the line: signing, encryption, authentication,
   authorization, credential comparison, transport verification. A value never consulted at an enforcement point is
   refuted.
5. Does deployment always supply the variable? Configurable only; no answer refutes, it only moves severity: always
   (every manifest sets it) lowers it, never is the most severe case, sometimes or unknown count as reachable.
Do not hunt new candidates. Confirm only with the code that makes it exploitable; reject citing the code that refutes
it; when you cannot complete the trace, answer needs-validation and say what blocked you.
<!-- /block -->
