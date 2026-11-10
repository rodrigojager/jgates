/**
 * Test evidence and matrix-level notes for each built-in adapter.
 * The manifest says what an adapter announces; this table says which test proves each integrated capability, which
 * limitation the published matrix states and what the adapter needs from outside. `verifyMatrix` (index.ts) fails
 * when a manifest capability has no entry here, when the referenced test file or title does not exist, when the cited
 * test does not say in its title that it exercises the capability (`[proves: <adapter>#<capability>]`), or when no
 * limitation is described.
 */

export interface TestRef {
  /** File name inside jgates/tests. */
  file: string;
  /** A substring of the title of a `test(...)` in that file; the title also carries `[proves: <adapter>#<capability>]`. */
  test: string;
}

export interface Bilingual {
  en: string;
  ptBR: string;
}

export interface CapabilityEvidence {
  /** Tests that prove the capability end to end. Empty only for a capability declared but not integrated. */
  tests: TestRef[];
  /** Set only when the capability is declared in the manifest but not integrated yet: the reason. */
  notIntegrated?: Bilingual;
  /**
   * The stack dimension: per stack id (a discovery language id or "any"), the tests whose fixture proves the
   * capability on that stack. A manifest row (stackSupport) in state "validated" needs an entry here; its tests carry
   * `[proves: <adapter>#<capability>]` or the narrower `[proves: <adapter>#<capability>@<stack>]` in the title.
   */
  stacks?: Record<string, TestRef[]>;
}

export interface AdapterEvidence {
  capabilities: Record<string, CapabilityEvidence>;
  limitation: Bilingual;
  external: Bilingual;
  /** Other tests of the adapter (parsers, manifest, planning). */
  otherTests?: TestRef[];
}

const t = (file: string, test: string): TestRef => ({ file, test });
/** A capability proven by the tests given, on the stacks their fixtures use. */
const proven = (stacks: string[], ...tests: TestRef[]): CapabilityEvidence => ({ tests, stacks: Object.fromEntries(stacks.map((s) => [s, tests])) });

const TRIVY = t("adapters-security.test.js", "Trivy 0.72.0: vulnerabilities, misconfigurations and secrets");

const BC_TS = t("adapter-build-check.test.js", "build-check typescript: tsc reports the type error with its location and the clean twin none");
const BC_MYPY = t("adapter-build-check.test.js", "build-check python (mypy): the type error is a located finding and the clean twin none");
const BC_PYRIGHT = t("adapter-build-check.test.js", "build-check python (pyright): the type error is a located finding and the clean twin none");
const BC_GO = t("adapter-build-check.test.js", "build-check go: go build reports the type error with its location and the clean twin none");
const BC_RUST = t("adapter-build-check.test.js", "build-check rust: cargo check reports the type error with its location and the clean twin none");
const BC_CSHARP = t("adapter-build-check.test.js", "build-check csharp: dotnet build reports the type error with its location and the clean twin none");

/** A bridge capability that runs only in the sidecar image: no test of the default suite exercises its scanner. */
const bridgeDeclared = (scanners: string): CapabilityEvidence => ({
  tests: [],
  notIntegrated: {
    en: `Runs ${scanners} through the bridge; the proof needs the Docker smoke of the bridge (the MegaLinter-based sidecar image), which the default suite does not run. The structure of the result is proven, the scanner is not.`,
    ptBR: `Roda ${scanners} pela ponte; a prova precisa do smoke com Docker da ponte (a imagem do sidecar, sobre o MegaLinter), que a suíte padrão não roda. A estrutura do resultado tem prova, o scanner não.`,
  },
});

export const ADAPTER_EVIDENCE: Record<string, AdapterEvidence> = {
  "quality-bridge": {
    capabilities: {
      lint: bridgeDeclared("MegaLinter"),
      sast: bridgeDeclared("Semgrep"),
      secrets: bridgeDeclared("Gitleaks"),
      dependencies: bridgeDeclared("Trivy and OSV-Scanner"),
      duplication: bridgeDeclared("jscpd"),
      iac: bridgeDeclared("Checkov and Trivy"),
      coverage: bridgeDeclared("the coverage of the project tests"),
      unit: bridgeDeclared("the project tests"),
      // The budget is the sidecar's own Python code: the default suite runs it for real.
      "file-size": proven(["any"], t("core-followups.test.js", "the bridge's file-size budget")),
    },
    limitation: {
      en: "Runs MegaLinter and the scanners through the bridge with the trusted configuration; the project's own linter configs are not used. Only file-size is proven in the default suite: the scanners need the Docker smoke of the bridge (sidecar image).",
      ptBR: "Roda o MegaLinter e os scanners pela ponte com a configuração confiável; as configurações de linter do projeto não são usadas. Só file-size tem prova na suíte padrão: os scanners precisam do smoke com Docker da ponte (imagem do sidecar).",
    },
    external: { en: "Python 3.11+, Docker image for MegaLinter", ptBR: "Python 3.11+, imagem Docker do MegaLinter" },
    otherTests: [t("run-bridge.test.js", "main fixture: one JSON result, valid, run kept outside the project"), t("run-bridge.test.js", "quick mode turns the external tools off")],
  },
  ruff: {
    capabilities: { lint: proven(["python"], t("adapter-ruff.test.js", "a known violation comes back as a finding")) },
    limitation: {
      en: "Reads the configuration file chosen in tools.yml, else Ruff's own resolution; the container runner uses only the image tools prepare pinned in .jgates/lock.json.",
      ptBR: "Lê o arquivo de configuração escolhido no tools.yml, senão a resolução própria do Ruff; o runner de container usa só a imagem que o tools prepare fixou no .jgates/lock.json.",
    },
    external: { en: "Ruff 0.17.2 (pip) or a container image", ptBR: "Ruff 0.17.2 (pip) ou imagem de container" },
  },
  "builtin-pii": {
    capabilities: { pii: proven(["any"], t("adapter-pii.test.js", "on the PII fixture the run reports CPF, CNPJ and credit-card")) },
    limitation: {
      en: "Detects CPF, CNPJ and credit card (phone is off by default); findings never carry the raw value.",
      ptBR: "Detecta CPF, CNPJ e cartão (telefone vem desligado); os achados nunca trazem o valor bruto.",
    },
    external: { en: "Python 3.11+ (JGates sidecar)", ptBR: "Python 3.11+ (sidecar do JGates)" },
  },
  eslint: {
    capabilities: { lint: proven(["typescript"], t("adapters-quality.test.js", "ESLint: the rule violation of the project's eslint.config")) },
    limitation: {
      en: "Enters the plan from the templates only with an eslint.config (typescript-eslint); an instance declared without one is blocked; the run executes project code, so it is never cached.",
      ptBR: "Entra no plano pelos templates só com um eslint.config (typescript-eslint); uma instância declarada sem ele fica bloqueada; a execução roda código do projeto e por isso nunca vem do cache.",
    },
    external: { en: "ESLint 9+ installed in the project", ptBR: "ESLint 9+ instalado no projeto" },
  },
  vitest: {
    capabilities: {
      unit: proven(["typescript"], t("adapter-vitest.test.js", "a fixture with passing tests returns the tests executed")),
      coverage: proven(["typescript"], t("adapter-vitest.test.js", "a fixture with passing tests returns the tests executed")),
    },
    limitation: {
      en: "Only the v8 coverage provider, installed at Vitest's exact version; a run never installs it.",
      ptBR: "Só o provedor de cobertura v8, instalado na versão exata do Vitest; o run nunca o instala.",
    },
    external: { en: "Vitest 1+ and @vitest/coverage-v8 in the project", ptBR: "Vitest 1+ e @vitest/coverage-v8 no projeto" },
    otherTests: [t("adapter-vitest.test.js", "a fast-check property test is reported as its own metric")],
  },
  semgrep: {
    capabilities: {
      sast: {
        // The bundled JGates pack: its vulnerable fixture (Python, JavaScript, TypeScript) yields findings, its clean twin none.
        stacks: {
          python: [t("adapter-semgrep.test.js", "a violation of a local rule comes back"), t("adapter-semgrep.test.js", "the bundled pack flags the vulnerable fixture")],
          javascript: [t("adapter-semgrep.test.js", "the bundled pack flags the vulnerable fixture")],
          typescript: [t("adapter-semgrep.test.js", "the bundled pack flags the vulnerable fixture")],
        },
        tests: [t("adapter-semgrep.test.js", "a violation of a local rule comes back"), t("adapter-semgrep.test.js", "the bundled pack flags the vulnerable fixture")],
      },
    },
    limitation: {
      en: "Runs local rules only (no registry at run time); the rules are prepared with tools prepare.",
      ptBR: "Roda só regras locais (sem registry na execução); as regras são preparadas com tools prepare.",
    },
    external: { en: "Semgrep 1.100+ (pip)", ptBR: "Semgrep 1.100+ (pip)" },
  },
  pytest: {
    capabilities: {
      unit: proven(["python"], t("adapter-pytest.test.js", "a failing test fails the step with the test name")),
      coverage: proven(["python"], t("adapter-pytest.test.js", "on the broken fixture the API coverage comes")),
    },
    limitation: {
      en: "Without pytest-cov the coverage is not measured (incomplete, never 0%); the run executes project code.",
      ptBR: "Sem pytest-cov a cobertura não é medida (incompleto, nunca 0%); a execução roda código do projeto.",
    },
    external: { en: "pytest 7+ and pytest-cov in the project environment", ptBR: "pytest 7+ e pytest-cov no ambiente do projeto" },
    otherTests: [t("adapter-pytest.test.js", "a Hypothesis property test is reported as its own metric")],
  },
  mutation: {
    capabilities: {
      mutation: {
        tests: [
          t("adapter-mutation.test.js", "mutation javascript: the weak suite leaves surviving mutants"),
          t("adapter-mutation.test.js", "mutation python: the mutmut results"),
        ],
        stacks: {
          javascript: [t("adapter-mutation.test.js", "mutation javascript: the weak suite leaves surviving mutants")],
          python: [t("adapter-mutation.test.js", "mutation python: the mutmut results")],
        },
      },
    },
    limitation: {
      en: "Runs StrykerJS or mutmut in an isolated copy of the component and re-runs the project's tests per mutant (project code executes, never cached); the time bound is the stage timeout; mutmut does not run natively on Windows (the stage is blocked with the reason); equivalent mutants count as survivors.",
      ptBR: "Roda o StrykerJS ou o mutmut numa cópia isolada do componente e reexecuta os testes do projeto por mutante (código do projeto executa, nunca vem do cache); o limite de tempo é o timeout da etapa; o mutmut não roda nativamente no Windows (a etapa fica bloqueada com o motivo); mutantes equivalentes contam como sobreviventes.",
    },
    external: { en: "@stryker-mutator/core 8+ in the project, or mutmut 3.x in the project's Python (Linux, macOS, WSL)", ptBR: "@stryker-mutator/core 8+ no projeto, ou mutmut 3.x no Python do projeto (Linux, macOS, WSL)" },
    otherTests: [t("adapter-mutation.test.js", "parseStrykerReport")],
  },
  "generic-command": {
    capabilities: {},
    limitation: {
      en: "No capability of its own: it credits a requirement only with a declared evidence contract (exit code, test runner or JSON file); effects must be declared.",
      ptBR: "Sem capacidade própria: só cobre um requisito com contrato de evidência declarado (código de saída, test runner ou arquivo JSON); os efeitos precisam ser declarados.",
    },
    external: { en: "The command the project declares", ptBR: "O comando que o projeto declara" },
    otherTests: [
      t("generic-command.test.js", "a project template with a generic check enters the plan"),
      t("generic-command.test.js", "a security claim with a json-file contract covers the requirement"),
    ],
  },
  "dependency-cruiser": {
    capabilities: { architecture: proven(["typescript"], t("adapter-dependency-cruiser.test.js", "the shared library importing the web component")) },
    limitation: {
      en: "Reads the import graph; an alias the tool does not resolve is a coverage gap, never a pass. Rules are judged by JGates from architecture.yml.",
      ptBR: "Lê o grafo de imports; um alias que a ferramenta não resolve é lacuna de cobertura, nunca aprovação. As regras são julgadas pelo JGates a partir do architecture.yml.",
    },
    external: { en: "dependency-cruiser 16+ (node_modules or JGates copy)", ptBR: "dependency-cruiser 16+ (node_modules ou cópia do JGates)" },
  },
  "import-linter": {
    capabilities: { architecture: proven(["python"], t("adapter-import-linter.test.js", "the domain importing the infrastructure is a finding of the declared rule")) },
    limitation: {
      en: "Needs a contract (generated from architecture.yml or a native configuration); an import that does not resolve is a coverage gap.",
      ptBR: "Exige um contrato (gerado do architecture.yml ou configuração nativa); um import que não resolve é lacuna de cobertura.",
    },
    external: { en: "import-linter 2.15 (pip) in the project environment", ptBR: "import-linter 2.15 (pip) no ambiente do projeto" },
  },
  zizmor: {
    capabilities: {
      "ci-cd": proven(["any"], t("adapter-zizmor.test.js", "zizmor: a template injection in a workflow is a normalized finding and the clean workflow none [proves: zizmor#ci-cd]")),
    },
    limitation: {
      en: "GitHub Actions workflows only; offline by default, so the audits that need the GitHub API are left out; ignore comments are scanner exceptions.",
      ptBR: "Só workflows do GitHub Actions; offline por padrão, então as auditorias que exigem a API do GitHub ficam de fora; comentários de ignorar são exceções do scanner.",
    },
    external: { en: "zizmor 1.32+ (in the JGates tools image)", ptBR: "zizmor 1.32+ (na imagem de ferramentas do JGates)" },
  },
  oasdiff: {
    capabilities: {
      "api-compatibility": proven(["any"], t("adapter-oasdiff.test.js", "oasdiff: a removed required response field is a breaking-change finding and an additive change none [proves: oasdiff#api-compatibility]")),
    },
    limitation: {
      en: "OpenAPI 3 files compared with a reference git revision or file; without a reference the stage is blocked, never passed; the binary is customer-supplied.",
      ptBR: "Arquivos OpenAPI 3 comparados com uma revisão git ou arquivo de referência; sem referência a etapa fica bloqueada, nunca aprovada; o binário é fornecido pelo cliente.",
    },
    external: { en: "oasdiff 1.10+ (customer-supplied binary: release, go install or package manager)", ptBR: "oasdiff 1.10+ (binário fornecido pelo cliente: release, go install ou gerenciador de pacotes)" },
  },
  schemathesis: {
    capabilities: {
      "api-contract": proven(["any"], t("adapter-runtime-api.test.js", "schemathesis: a target violating its OpenAPI schema yields findings with a reproduction and the conforming twin none [proves: schemathesis#api-contract]")),
    },
    limitation: {
      en: "Runs only against a configured running target (local or disposable, never production); without a target the stage is blocked, never passed; OpenAPI HTTP APIs only.",
      ptBR: "Roda só contra um alvo em execução configurado (local ou descartável, nunca produção); sem alvo a etapa fica bloqueada, nunca aprovada; só APIs HTTP descritas em OpenAPI.",
    },
    external: { en: "schemathesis 4.x (in the JGates tools image) and a running target", ptBR: "schemathesis 4.x (na imagem de ferramentas do JGates) e um alvo em execução" },
  },
  zap: {
    capabilities: {
      dast: proven(["any"], t("adapter-runtime-api.test.js", "zap: the passive API scan of a target missing security headers yields alerts and the hardened twin none [proves: zap#dast]")),
    },
    limitation: {
      en: "Runs only against a configured running target; passive by default, active only when the instance sets mode: active and allowActive: true; without a target the stage is blocked, never passed.",
      ptBR: "Roda só contra um alvo em execução configurado; passivo por padrão, ativo só quando a instância define mode: active e allowActive: true; sem alvo a etapa fica bloqueada, nunca aprovada.",
    },
    external: { en: "Docker and the ZAP image ghcr.io/zaproxy/zaproxy (customer-supplied, never pulled during a run)", ptBR: "Docker e a imagem do ZAP ghcr.io/zaproxy/zaproxy (fornecidos pelo cliente, nunca baixados durante uma execução)" },
  },
  codeql: {
    capabilities: {
      dataflow: proven(["any"], t("adapter-codeql.test.js", "codeql: a CodeQL SARIF with a path-problem is a normalized dataflow finding and a clean one none [proves: codeql#dataflow]")),
    },
    limitation: {
      en: "Customer-supplied: the CodeQL CLI, its query packs and the entitlement under the CodeQL terms are the customer's; without them the stage is blocked with setup guidance, never passed. Every CodeQL row is customer-setup-required (no real CodeQL runs in JGates tests).",
      ptBR: "Fornecido pelo cliente: o CodeQL CLI, os pacotes de consultas e o direito de uso pelos termos do CodeQL são do cliente; sem eles a etapa fica bloqueada com orientação de configuração, nunca aprovada. Toda linha do CodeQL é exige-configuração-do-cliente (nenhum CodeQL real roda nos testes do JGates).",
    },
    external: { en: "CodeQL CLI 2.15+ (customer-supplied; never installed by JGates)", ptBR: "CodeQL CLI 2.15+ (fornecido pelo cliente; nunca instalado pelo JGates)" },
  },
  "build-check": {
    capabilities: {
      typecheck: {
        tests: [BC_TS, BC_MYPY, BC_PYRIGHT, BC_GO, BC_RUST, BC_CSHARP],
        stacks: { typescript: [BC_TS], python: [BC_MYPY, BC_PYRIGHT], go: [BC_GO], rust: [BC_RUST], csharp: [BC_CSHARP] },
      },
    },
    limitation: {
      en: "Runs the project's own checker with the project's own configuration; a component without that configuration is skipped and reported, never passed; cargo, dotnet and mypy plugins run project code; the toolchains are customer-supplied.",
      ptBR: "Roda o verificador do próprio projeto com a configuração dele; um componente sem essa configuração é ignorado e informado, nunca aprovado; cargo, dotnet e plugins do mypy executam código do projeto; os toolchains são do cliente.",
    },
    external: {
      en: "tsc 4.5+, mypy 1.0+ or pyright 1.1.300+, Go 1.18+, cargo 1.60+, .NET SDK 6+ (customer-supplied; never installed during a run)",
      ptBR: "tsc 4.5+, mypy 1.0+ ou pyright 1.1.300+, Go 1.18+, cargo 1.60+, SDK .NET 6+ (do cliente; nunca instalados durante uma execução)",
    },
    otherTests: [t("adapter-build-check.test.js", "build-check: a stack whose checker is missing is blocked with the way to get it and never passed")],
  },
  gitleaks: {
    capabilities: {
      secrets: proven(["any"], t("adapters-security.test.js", "Gitleaks runs in the container and its finding")),
      "secrets-history": proven(["any"], t("adapters-security.test.js", "Gitleaks: a report that carries the secret anyway")),
    },
    limitation: {
      en: "Runs in a container only; the value found is masked; a report cut or from another version is an error.",
      ptBR: "Roda só em container; o valor encontrado é mascarado; um relatório cortado ou de outra versão é erro.",
    },
    external: { en: "Docker and the security-scanners image (by digest)", ptBR: "Docker e a imagem security-scanners (por digest)" },
  },
  trivy: {
    capabilities: {
      dependencies: proven(["any"], TRIVY),
      iac: proven(["any"], TRIVY),
      secrets: proven(["any"], TRIVY),
      licenses: proven(["any"], t("core-followups.test.js", "Trivy licenses: the recorded license report of 0.72.0")),
    },
    limitation: {
      en: "Runs in a container only; the vulnerability database is cached in the data folder and recorded with source and date.",
      ptBR: "Roda só em container; o banco de vulnerabilidades fica em cache na pasta de dados e é registrado com fonte e data.",
    },
    external: { en: "Docker, the security-scanners image and the vulnerability database", ptBR: "Docker, a imagem security-scanners e o banco de vulnerabilidades" },
    otherTests: [
      t("adapter-trivy-image.test.js", "trivy image: a tarball scan yields normalized findings"),
      t("adapter-trivy-image.test.js", "trivy final-image setting: imageRef and imageTarball select the image mode in the plan"),
      t("adapter-trivy-image.test.js", "trivy final-image run: a missing Trivy and container runtime is a blocked stage, never a clean image"),
    ],
  },
  "supply-chain": {
    capabilities: {
      "supply-chain": proven(["any"], t("adapter-supply-chain.test.js", "supply-chain: a postinstall dependency without integrity is a finding and a clean lockfile none [proves: supply-chain#supply-chain]")),
    },
    limitation: {
      en: "Reads npm and Python lockfiles offline; the deprecation of Python packages needs a registry and stays unknown (never clean); an unreadable lockfile leaves the stage not interpreted instead of passed; requirements.txt is read only through the lockfiles setting.",
      ptBR: "Lê lockfiles npm e Python offline; a descontinuação de pacotes Python exige um registro e fica desconhecida (nunca limpa); um lockfile ilegível deixa a etapa não interpretada em vez de aprovada; requirements.txt só é lido pela configuração lockfiles.",
    },
    external: { en: "None: shipped with JGates (reads the lockfiles in-process, no network)", ptBR: "Nenhuma: vem com o JGates (lê os lockfiles no processo, sem rede)" },
    otherTests: [
      t("adapter-supply-chain.test.js", "supply-chain plan and run: the risky lockfile is a normalized finding"),
      t("adapter-supply-chain.test.js", "supply-chain run: an unknown is never counted as clean"),
    ],
  },
  "osv-scanner": {
    capabilities: { dependencies: proven(["any"], t("adapters-security.test.js", "OSV-Scanner 2.4.0")) },
    limitation: {
      en: "Runs in a container only; one finding per advisory group.",
      ptBR: "Roda só em container; um achado por grupo de advisory.",
    },
    external: { en: "Docker and the security-scanners image; advisory database", ptBR: "Docker e a imagem security-scanners; banco de advisories" },
  },
  checkov: {
    capabilities: { iac: proven(["any"], t("adapters-security.test.js", "Checkov 3.3.8")) },
    limitation: {
      en: "Runs in a container only; failed checks are reported as MEDIUM findings.",
      ptBR: "Roda só em container; as verificações reprovadas viram achados MEDIUM.",
    },
    external: { en: "Docker and the security-scanners image", ptBR: "Docker e a imagem security-scanners" },
  },
  govulncheck: {
    capabilities: {
      dependencies: proven(["go"], t("adapter-stack-extensions.test.js", "govulncheck: a vulnerable yaml.v2 the code calls is a normalized finding and the patched twin none [proves: govulncheck#dependencies]")),
    },
    otherTests: [t("adapter-stack-extensions.test.js", "govulncheck recorded output (1.9.0)")],
    limitation: {
      en: "Customer-supplied binary (BSD-3-Clause), source mode: only vulnerabilities whose symbol the code reaches are findings, with an unknown severity because the Go database has none; needs the Go toolchain, a complete go.sum and the network for vuln.go.dev. Proven on a Go module fixture with govulncheck 1.9.0.",
      ptBR: "Binário fornecido pelo cliente (BSD-3-Clause), modo código-fonte: só as vulnerabilidades cujo símbolo o código alcança são achados, com severidade desconhecida porque o banco do Go não tem; precisa do toolchain Go, de um go.sum completo e de rede para vuln.go.dev. Provado em um módulo Go de teste com govulncheck 1.9.0.",
    },
    external: { en: "govulncheck 1.0+ (go install; customer-supplied), the Go toolchain, network to vuln.go.dev", ptBR: "govulncheck 1.0+ (go install; do cliente), toolchain Go, rede para vuln.go.dev" },
  },
  "cargo-audit": {
    capabilities: {
      dependencies: proven(["rust"], t("adapter-stack-extensions.test.js", "cargo-audit: a RustSec-advised crate in Cargo.lock is a normalized finding and the clean twin none [proves: cargo-audit#dependencies]")),
    },
    otherTests: [t("adapter-stack-extensions.test.js", "cargo-audit recorded output (0.22.2)")],
    limitation: {
      en: "Customer-supplied binary (Apache-2.0 OR MIT): advisories are matched on the versions locked in Cargo.lock, not on the call graph; the RustSec database is cloned on every run (network); unmaintained, unsound and yanked packages are non-blocking findings. Proven on a Cargo.lock fixture with cargo-audit 0.22.2.",
      ptBR: "Binário fornecido pelo cliente (Apache-2.0 OR MIT): os avisos são casados com as versões travadas no Cargo.lock, não com o grafo de chamadas; o banco do RustSec é clonado a cada execução (rede); pacotes sem manutenção, inseguros ou removidos são achados que não bloqueiam. Provado em um Cargo.lock de teste com cargo-audit 0.22.2.",
    },
    external: { en: "cargo-audit 0.20+ (cargo install; customer-supplied), network to github.com", ptBR: "cargo-audit 0.20+ (cargo install; do cliente), rede para github.com" },
  },
  "cargo-test": {
    capabilities: {
      tests: proven(["rust"], t("adapter-cargo-test.test.js", "cargo-test: an ordinary failing #[test] is cargo-test.test-failed, not a property failure, and a crate without proptest has no property metrics [proves: cargo-test#tests, cargo-test#tests@rust]")),
      properties: proven(["rust"], t("adapter-cargo-test.test.js", "cargo-test: a failing proptest property is cargo-test.property-failed with the minimal failing input and the clean twin none [proves: cargo-test#properties, cargo-test#properties@rust]")),
    },
    otherTests: [t("adapter-cargo-test.test.js", "cargo-test: with cargo absent from the tools image the stage is blocked with the image's cause, never passed"), t("adapter-cargo-test.test.js", "cargo-test recorded libtest output")],
    limitation: {
      en: "Customer-supplied toolchain (cargo, MIT OR Apache-2.0): runs cargo test --offline and parses the stable libtest text output; proptest properties are found statically (proptest! blocks and #[proptest] functions); the tests, build scripts and procedural macros of the project execute, so the result is self-reported and never cached; dependencies must already be in the cargo home. Proven on Rust crate fixtures with the real cargo 1.99.1 and proptest 1.x.",
      ptBR: "Toolchain fornecido pelo cliente (cargo, MIT OR Apache-2.0): roda cargo test --offline e lê a saída de texto estável do libtest; as propriedades do proptest são achadas de forma estática (blocos proptest! e funções #[proptest]); os testes, build scripts e macros procedurais do projeto executam, então o resultado é autodeclarado e nunca vem do cache; as dependências já precisam estar no cargo home. Provado em crates Rust de teste com o cargo 1.99.1 real e o proptest 1.x.",
    },
    external: { en: "cargo and rustc 1.60+ (rustup; customer-supplied), proptest 1.x fetched in the cargo home", ptBR: "cargo e rustc 1.60+ (rustup; do cliente), proptest 1.x baixado no cargo home" },
  },
  jscpd: {
    capabilities: { duplication: proven(["typescript"], t("adapters-quality.test.js", "jscpd: the duplications of a fixture come out")) },
    limitation: {
      en: "Reads the config chosen by the user (binding or .jscpd.json); a config that is not JSON refuses the plan.",
      ptBR: "Lê a configuração escolhida pelo usuário (binding ou .jscpd.json); uma configuração que não é JSON recusa o plano.",
    },
    external: { en: "jscpd 5.3.3 (JGates dependency)", ptBR: "jscpd 5.3.3 (dependência do JGates)" },
  },
};

/** Operating systems the first version declares: only what was tested. */
export const OS_STATUS: Record<"linux" | "win32" | "darwin", Bilingual> = {
  linux: { en: "tested", ptBR: "testado" },
  win32: { en: "not tested yet", ptBR: "ainda não testado" },
  darwin: { en: "not tested on real hardware", ptBR: "não testado em máquina real" },
};
