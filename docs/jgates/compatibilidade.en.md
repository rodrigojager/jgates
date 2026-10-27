# JGates compatibility matrix

This matrix is generated from the adapter manifests and the test evidence (`jgates tools matrix --json`). Each integrated capability names the test file that proves it (in `jgates/tests`) and each adapter states its limitation. A test (`jgates/tests/matrix.test.js`) fails if a capability is announced without an existing test or without a described limitation, and if this table differs from the command output. To regenerate the tables: `npm --prefix jgates run build && npm --prefix jgates run docs:compat`.

## Operating systems

- Linux: tested.
- Windows: not tested yet; tests that depend on Windows are marked and skip elsewhere.
- macOS: not tested on real hardware.

## Partial support

Go and Rust have partial support: discovery, explicit configuration and the generic command with `go test` and `cargo test`. What each stack does not cover is in the second table. .NET is partial as well.

## Matrix

<!-- matrix:start -->
| Adapter | Tool and version | Languages | Capabilities (proving test) | Editing | Support | Runner | OS (Linux / Windows / macOS) | Limitation | External dependencies |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Quality gate (bridge) (`quality-bridge`) | quality-gate | - | lint (declared, not proven); sast (declared, not proven); secrets (declared, not proven); dependencies (declared, not proven); duplication (declared, not proven); iac (declared, not proven); coverage (declared, not proven); unit (declared, not proven); file-size (core-followups.test.js) | text | editable-file | local, container | tested / not tested yet / not tested on real hardware | Runs MegaLinter and the scanners through the bridge with the trusted configuration; the project's own linter configs are not used. Only file-size is proven in the default suite: the scanners need the Docker smoke of the bridge (sidecar image). | Python 3.11+, Docker image for MegaLinter |
| Ruff (`ruff`) | ruff >=0.5.0 | python | lint (adapter-ruff.test.js) | text, structured-read, structured-write | assisted | local, container | tested / not tested yet / not tested on real hardware | Reads the configuration file chosen in tools.yml, else Ruff's own resolution; the container runner uses only the image tools prepare pinned in .jgates/lock.json. | Ruff 0.17.2 (pip) or a container image |
| PII (built-in detector) (`builtin-pii`) | quality-sidecar-pii | - | pii (adapter-pii.test.js) | text | editable-file | local | tested / not tested yet / not tested on real hardware | Detects CPF, CNPJ and credit card (phone is off by default); findings never carry the raw value. | Python 3.11+ (JGates sidecar) |
| ESLint (`eslint`) | eslint >=9.0.0 | javascript, typescript | lint (adapters-quality.test.js) | text, partial | editable-file | local | tested / not tested yet / not tested on real hardware | Enters the plan from the templates only with an eslint.config (typescript-eslint); an instance declared without one is blocked; the run executes project code, so it is never cached. | ESLint 9+ installed in the project |
| Vitest (`vitest`) | vitest >=1.0.0 | javascript, typescript | unit (adapter-vitest.test.js); coverage (adapter-vitest.test.js) | text, partial | editable-file | local | tested / not tested yet / not tested on real hardware | Only the v8 coverage provider, installed at Vitest's exact version; a run never installs it. | Vitest 1+ and @vitest/coverage-v8 in the project |
| Semgrep (local rules) (`semgrep`) | semgrep >=1.100.0 | - | sast (adapter-semgrep.test.js) | text | editable-file | local | tested / not tested yet / not tested on real hardware | Runs local rules only (no registry at run time); the rules are prepared with tools prepare. | Semgrep 1.100+ (pip) |
| pytest (`pytest`) | pytest >=7.0.0 | python | unit (adapter-pytest.test.js); coverage (adapter-pytest.test.js) | text, structured-read, structured-write | assisted | local | tested / not tested yet / not tested on real hardware | Without pytest-cov the coverage is not measured (incomplete, never 0%); the run executes project code. | pytest 7+ and pytest-cov in the project environment |
| Generic command (`generic-command`) | generic-command | - | - | text | editable-file | local | tested / not tested yet / not tested on real hardware | No capability of its own: it credits a requirement only with a declared evidence contract (exit code, test runner or JSON file); effects must be declared. | The command the project declares |
| dependency-cruiser (TS/JS architecture) (`dependency-cruiser`) | dependency-cruiser >=16.0.0 | javascript, typescript | architecture (adapter-dependency-cruiser.test.js) | text | editable-file | local | tested / not tested yet / not tested on real hardware | Reads the import graph; an alias the tool does not resolve is a coverage gap, never a pass. Rules are judged by JGates from architecture.yml. | dependency-cruiser 16+ (node_modules or JGates copy) |
| Import Linter (Python architecture) (`import-linter`) | import-linter >=2.15.0 <3.0.0 | python | architecture (adapter-import-linter.test.js) | text | editable-file | local | tested / not tested yet / not tested on real hardware | Needs a contract (generated from architecture.yml or a native configuration); an import that does not resolve is a coverage gap. | import-linter 2.15 (pip) in the project environment |
| Gitleaks (`gitleaks`) | gitleaks >=8.19.0 <9.0.0 | - | secrets (adapters-security.test.js); secrets-history (adapters-security.test.js) | text | editable-file | container | tested / not tested yet / not tested on real hardware | Runs in a container only; the value found is masked; a report cut or from another version is an error. | Docker and the security-scanners image (by digest) |
| Trivy (`trivy`) | trivy >=0.56.0 <1.0.0 | - | dependencies (adapters-security.test.js); iac (adapters-security.test.js); secrets (adapters-security.test.js); licenses (core-followups.test.js) | text | editable-file | container | tested / not tested yet / not tested on real hardware | Runs in a container only; the vulnerability database is cached in the data folder and recorded with source and date. | Docker, the security-scanners image and the vulnerability database |
| OSV-Scanner (`osv-scanner`) | osv-scanner >=2.0.0 <3.0.0 | - | dependencies (adapters-security.test.js) | text | editable-file | container | tested / not tested yet / not tested on real hardware | Runs in a container only; one finding per advisory group. | Docker and the security-scanners image; advisory database |
| Checkov (`checkov`) | checkov >=3.0.0 <4.0.0 | - | iac (adapters-security.test.js) | text | editable-file | container | tested / not tested yet / not tested on real hardware | Runs in a container only; failed checks are reported as MEDIUM findings. | Docker and the security-scanners image |
| jscpd (duplication) (`jscpd`) | jscpd >=4.0.0 | - | duplication (adapters-quality.test.js) | text | editable-file | local | tested / not tested yet / not tested on real hardware | Reads the config chosen by the user (binding or .jscpd.json); a config that is not JSON refuses the plan. | jscpd 5.3.3 (JGates dependency) |

| Stack | Support | Not covered |
| --- | --- | --- |
| Base (`base`) | full | - |
| .NET (`dotnet`) | partial | Build do projeto (dotnet build); Testes do projeto (dotnet test); Cobertura de testes; Analisadores Roslyn e regras do .editorconfig; Typecheck do compilador |
| Go (`go`) | partial | Build e go vet; Cobertura de testes; Análise de dependências (go.sum); Linters (staticcheck, golangci-lint) |
| Python com Import Linter (`python-import-linter`) | full | - |
| Python com pytest (`python-pytest`) | full | - |
| Python e TypeScript (`python-typescript`) | full | - |
| Python (`python`) | full | - |
| Rust (`rust`) | partial | Build (cargo build); clippy; Cobertura de testes; Análise de dependências (cargo audit, cargo deny) |
| TypeScript com dependency-cruiser (`typescript-dependency-cruiser`) | full | - |
| TypeScript com ESLint (`typescript-eslint`) | full | - |
| TypeScript com Vitest (`typescript-vitest`) | full | - |
| TypeScript (`typescript`) | full | - |
<!-- matrix:end -->
