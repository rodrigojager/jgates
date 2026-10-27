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
}

export interface AdapterEvidence {
  capabilities: Record<string, CapabilityEvidence>;
  limitation: Bilingual;
  external: Bilingual;
  /** Other tests of the adapter (parsers, manifest, planning). */
  otherTests?: TestRef[];
}

const t = (file: string, test: string): TestRef => ({ file, test });
const proven = (...tests: TestRef[]): CapabilityEvidence => ({ tests });

const TRIVY = t("adapters-security.test.js", "Trivy 0.72.0: vulnerabilities, misconfigurations and secrets");

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
      "file-size": proven(t("core-followups.test.js", "the bridge's file-size budget")),
    },
    limitation: {
      en: "Runs MegaLinter and the scanners through the bridge with the trusted configuration; the project's own linter configs are not used. Only file-size is proven in the default suite: the scanners need the Docker smoke of the bridge (sidecar image).",
      ptBR: "Roda o MegaLinter e os scanners pela ponte com a configuração confiável; as configurações de linter do projeto não são usadas. Só file-size tem prova na suíte padrão: os scanners precisam do smoke com Docker da ponte (imagem do sidecar).",
    },
    external: { en: "Python 3.11+, Docker image for MegaLinter", ptBR: "Python 3.11+, imagem Docker do MegaLinter" },
    otherTests: [t("run-bridge.test.js", "main fixture: one JSON result, valid, run kept outside the project"), t("run-bridge.test.js", "quick mode turns the external tools off")],
  },
  ruff: {
    capabilities: { lint: proven(t("adapter-ruff.test.js", "a known violation comes back as a finding")) },
    limitation: {
      en: "Reads the configuration file chosen in tools.yml, else Ruff's own resolution; the container runner uses only the image tools prepare pinned in .jgates/lock.json.",
      ptBR: "Lê o arquivo de configuração escolhido no tools.yml, senão a resolução própria do Ruff; o runner de container usa só a imagem que o tools prepare fixou no .jgates/lock.json.",
    },
    external: { en: "Ruff 0.17.2 (pip) or a container image", ptBR: "Ruff 0.17.2 (pip) ou imagem de container" },
  },
  "builtin-pii": {
    capabilities: { pii: proven(t("adapter-pii.test.js", "on the PII fixture the run reports CPF, CNPJ and credit-card")) },
    limitation: {
      en: "Detects CPF, CNPJ and credit card (phone is off by default); findings never carry the raw value.",
      ptBR: "Detecta CPF, CNPJ e cartão (telefone vem desligado); os achados nunca trazem o valor bruto.",
    },
    external: { en: "Python 3.11+ (JGates sidecar)", ptBR: "Python 3.11+ (sidecar do JGates)" },
  },
  eslint: {
    capabilities: { lint: proven(t("adapters-quality.test.js", "ESLint: the rule violation of the project's eslint.config")) },
    limitation: {
      en: "Enters the plan from the templates only with an eslint.config (typescript-eslint); an instance declared without one is blocked; the run executes project code, so it is never cached.",
      ptBR: "Entra no plano pelos templates só com um eslint.config (typescript-eslint); uma instância declarada sem ele fica bloqueada; a execução roda código do projeto e por isso nunca vem do cache.",
    },
    external: { en: "ESLint 9+ installed in the project", ptBR: "ESLint 9+ instalado no projeto" },
  },
  vitest: {
    capabilities: {
      unit: proven(t("adapter-vitest.test.js", "a fixture with passing tests returns the tests executed")),
      coverage: proven(t("adapter-vitest.test.js", "a fixture with passing tests returns the tests executed")),
    },
    limitation: {
      en: "Only the v8 coverage provider, installed at Vitest's exact version; a run never installs it.",
      ptBR: "Só o provedor de cobertura v8, instalado na versão exata do Vitest; o run nunca o instala.",
    },
    external: { en: "Vitest 1+ and @vitest/coverage-v8 in the project", ptBR: "Vitest 1+ e @vitest/coverage-v8 no projeto" },
  },
  semgrep: {
    capabilities: { sast: proven(t("adapter-semgrep.test.js", "a violation of a local rule comes back")) },
    limitation: {
      en: "Runs local rules only (no registry at run time); the rules are prepared with tools prepare.",
      ptBR: "Roda só regras locais (sem registry na execução); as regras são preparadas com tools prepare.",
    },
    external: { en: "Semgrep 1.100+ (pip)", ptBR: "Semgrep 1.100+ (pip)" },
  },
  pytest: {
    capabilities: {
      unit: proven(t("adapter-pytest.test.js", "a failing test fails the step with the test name")),
      coverage: proven(t("adapter-pytest.test.js", "on the broken fixture the API coverage comes")),
    },
    limitation: {
      en: "Without pytest-cov the coverage is not measured (incomplete, never 0%); the run executes project code.",
      ptBR: "Sem pytest-cov a cobertura não é medida (incompleto, nunca 0%); a execução roda código do projeto.",
    },
    external: { en: "pytest 7+ and pytest-cov in the project environment", ptBR: "pytest 7+ e pytest-cov no ambiente do projeto" },
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
    capabilities: { architecture: proven(t("adapter-dependency-cruiser.test.js", "the shared library importing the web component")) },
    limitation: {
      en: "Reads the import graph; an alias the tool does not resolve is a coverage gap, never a pass. Rules are judged by JGates from architecture.yml.",
      ptBR: "Lê o grafo de imports; um alias que a ferramenta não resolve é lacuna de cobertura, nunca aprovação. As regras são julgadas pelo JGates a partir do architecture.yml.",
    },
    external: { en: "dependency-cruiser 16+ (node_modules or JGates copy)", ptBR: "dependency-cruiser 16+ (node_modules ou cópia do JGates)" },
  },
  "import-linter": {
    capabilities: { architecture: proven(t("adapter-import-linter.test.js", "the domain importing the infrastructure is a finding of the declared rule")) },
    limitation: {
      en: "Needs a contract (generated from architecture.yml or a native configuration); an import that does not resolve is a coverage gap.",
      ptBR: "Exige um contrato (gerado do architecture.yml ou configuração nativa); um import que não resolve é lacuna de cobertura.",
    },
    external: { en: "import-linter 2.15 (pip) in the project environment", ptBR: "import-linter 2.15 (pip) no ambiente do projeto" },
  },
  gitleaks: {
    capabilities: {
      secrets: proven(t("adapters-security.test.js", "Gitleaks runs in the container and its finding")),
      "secrets-history": proven(t("adapters-security.test.js", "Gitleaks: a report that carries the secret anyway")),
    },
    limitation: {
      en: "Runs in a container only; the value found is masked; a report cut or from another version is an error.",
      ptBR: "Roda só em container; o valor encontrado é mascarado; um relatório cortado ou de outra versão é erro.",
    },
    external: { en: "Docker and the security-scanners image (by digest)", ptBR: "Docker e a imagem security-scanners (por digest)" },
  },
  trivy: {
    capabilities: {
      dependencies: proven(TRIVY),
      iac: proven(TRIVY),
      secrets: proven(TRIVY),
      licenses: proven(t("core-followups.test.js", "Trivy licenses: the recorded license report of 0.72.0")),
    },
    limitation: {
      en: "Runs in a container only; the vulnerability database is cached in the data folder and recorded with source and date.",
      ptBR: "Roda só em container; o banco de vulnerabilidades fica em cache na pasta de dados e é registrado com fonte e data.",
    },
    external: { en: "Docker, the security-scanners image and the vulnerability database", ptBR: "Docker, a imagem security-scanners e o banco de vulnerabilidades" },
  },
  "osv-scanner": {
    capabilities: { dependencies: proven(t("adapters-security.test.js", "OSV-Scanner 2.4.0")) },
    limitation: {
      en: "Runs in a container only; one finding per advisory group.",
      ptBR: "Roda só em container; um achado por grupo de advisory.",
    },
    external: { en: "Docker and the security-scanners image; advisory database", ptBR: "Docker e a imagem security-scanners; banco de advisories" },
  },
  checkov: {
    capabilities: { iac: proven(t("adapters-security.test.js", "Checkov 3.3.8")) },
    limitation: {
      en: "Runs in a container only; failed checks are reported as MEDIUM findings.",
      ptBR: "Roda só em container; as verificações reprovadas viram achados MEDIUM.",
    },
    external: { en: "Docker and the security-scanners image", ptBR: "Docker e a imagem security-scanners" },
  },
  jscpd: {
    capabilities: { duplication: proven(t("adapters-quality.test.js", "jscpd: the duplications of a fixture come out")) },
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
