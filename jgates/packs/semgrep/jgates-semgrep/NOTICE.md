# JGates Semgrep rule pack

Original rules written for JGates, under the MIT license (see `LICENSE`). They cover injection (including SQL,
command, XSS and XXE), SSRF, path traversal, weak cryptography and TLS, insecure deserialization and authorization
patterns for eight languages: JavaScript/TypeScript, Python, Go, C#, Rust, Java and PHP. Java and PHP have no stack in
JGates: for them the pack is the only language-specific check (SAST), next to the checks that work on any project.
Template files (Jinja, Blade, Razor and the like) are not scanned.

- Provenance: authored in this repository; nothing is copied or adapted from another rule collection. The official
  Semgrep registry rules are under their own restrictive terms and are never bundled here.
- Engine: the rules are written and tested for Semgrep 1.100 or later and were last verified with Semgrep 1.184.0.
  Semgrep itself (LGPL-2.1) is not part of this pack; the customer installs it.
- Layout: the JavaScript and Python rule files are `rules/<language>-<group>.yaml`; every other language has its own
  folder, `rules/<language>/`.
- Tests: each rule file has a test file with the same name (any other extension) annotated with `ruleid:` and `ok:`
  comments. Run `semgrep --test rules`.
