# JGates Semgrep rule pack

Original rules written for JGates, under the MIT license (see `LICENSE`). They cover injection (including SQL,
command, XSS and XXE), SSRF, path traversal, weak cryptography and TLS, insecure deserialization, authorization,
passwords and sessions, cookies and CORS, tokens and transport, file handling, error handling and logging, and
configuration, for nine kinds of file: JavaScript/TypeScript, Python, Go, C#, Rust, Java, PHP, HTML files and
configuration files. Java and PHP have no stack in JGates: for them the pack is the only language-specific check
(SAST), next to the checks that work on any project. Template files (Jinja, Blade, Razor, EJS, Go templates, Vue files)
are not scanned.

- Groups: interpreters, encoding, cookies-cors, web-protocol, files, passwords-sessions, tokens-transport,
  crypto-params, errors-logging, configuration and signals, besides the earlier injection, taint, XSS, crypto-auth and
  deserialization files; HTML files have a markup group and configuration files a server and a framework group.
- Severities: `ERROR` and `WARNING` rules block; `INFO` rules are informational findings that do not block the
  validation. The rules of the `signals` group (`jgates.<kind>.uses-<tag>`) only record what a scan saw.

- Provenance: authored in this repository; nothing is copied or adapted from another rule collection. The official
  Semgrep registry rules are under their own restrictive terms and are never bundled here.
- Engine: the rules are written and tested for Semgrep 1.100 or later and were last verified with Semgrep 1.184.0.
  Semgrep itself (LGPL-2.1) is not part of this pack; the customer installs it.
- Layout: the JavaScript and Python rule files are `rules/<language>-<group>.yaml`; every other language has its own
  folder, `rules/<language>/`.
- Tests: each rule file has a test file with the same name (any other extension) annotated with `ruleid:` and `ok:`
  comments. Run `semgrep --test rules`.
