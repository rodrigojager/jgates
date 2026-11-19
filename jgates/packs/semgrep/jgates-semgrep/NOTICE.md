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
- Four check classes: `ERROR` and `WARNING` describe explicit risk and block under the applicable rigor;
  ordinary `INFO` checks produce informational findings that do not block the validation; **Review** checks
  (`severity: INFO`, `metadata.class: review`) point at locally absent protections and produce findings **To review**,
  never informational findings. Review never blocks in any profile or mode and never examines an ASVS requirement.
  **Mark as reviewed** records a per-occurrence project waiver; Review alone never produces "approved with N waivers".
  There are 711 checks (277 ERROR, 229 WARNING, 116 ordinary INFO, 89 Review) and 113 signals: 824 rules in total.
  The rules of the `signals` group (`jgates.<kind>.uses-<tag>`) only record what a scan saw, never findings or examined checks.

- Provenance: authored in this repository; nothing is copied or adapted from another rule collection. The official
  Semgrep registry rules are under their own restrictive terms and are never bundled here.
- Engine: the rules are written and tested for Semgrep 1.100 or later and were last verified with Semgrep 1.184.0.
  Semgrep itself (LGPL-2.1) is not part of this pack; the customer installs it.
- Layout: the JavaScript and Python rule files are `rules/<language>-<group>.yaml`; every other language has its own
  folder, `rules/<language>/`.
- Tests: each rule file has a test file with the same name (any other extension) annotated with `ruleid:` and `ok:`
  comments. Run `semgrep --test rules`.
