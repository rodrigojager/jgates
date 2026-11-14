# JGates Semgrep rule pack

Original rules written for JGates, under the MIT license (see `LICENSE`). They cover injection, SSRF, path traversal,
weak cryptography, insecure deserialization and authorization patterns for Python and JavaScript/TypeScript.

- Provenance: authored in this repository; nothing is copied or adapted from another rule collection. The official
  Semgrep registry rules are under their own restrictive terms and are never bundled here.
- Engine: the rules are written and tested for Semgrep 1.100 or later and were last verified with Semgrep 1.184.0.
  Semgrep itself (LGPL-2.1) is not part of this pack; the customer installs it.
- Tests: each `rules/<name>.yaml` has a test file with the same name (`.py` or `.js`) annotated with `ruleid:` and
  `ok:` comments. Run `semgrep --test rules`.
