# Matriz de compatibilidade do JGates

Esta matriz é gerada dos manifestos dos adaptadores e das evidências de teste (`jgates tools matrix --json`). Cada capacidade integrada cita o arquivo de teste que a prova (em `jgates/tests`) e cada adaptador descreve a sua limitação. Um teste (`jgates/tests/matrix.test.js`) falha se uma capacidade for anunciada sem teste existente ou sem limitação descrita, e se esta tabela divergir da saída do comando. Para regenerar as tabelas: `npm --prefix jgates run build && npm --prefix jgates run docs:compat`.

## Sistemas operacionais

- Linux: testado.
- Windows: ainda não testado; os testes que dependem do Windows estão marcados e pulam fora dele.
- macOS: não testado em máquina real.

## Suporte parcial

Go e Rust têm suporte parcial: descoberta, configuração explícita e o comando genérico com `go test` e `cargo test`. O que cada stack não cobre está na segunda tabela. .NET também é parcial.

## Matriz

<!-- matrix:start -->
| Adaptador | Ferramenta e versão | Linguagens | Capacidades (teste que prova) | Edição | Suporte | Runner | SO (Linux / Windows / macOS) | Limitação | Dependências externas |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Quality gate (bridge) (`quality-bridge`) | quality-gate | - | lint (declarada, sem prova); sast (declarada, sem prova); secrets (declarada, sem prova); dependencies (declarada, sem prova); duplication (declarada, sem prova); iac (declarada, sem prova); coverage (declarada, sem prova); unit (declarada, sem prova); file-size (core-followups.test.js) | text | editable-file | local, container | testado / ainda não testado / não testado em máquina real | Roda o MegaLinter e os scanners pela ponte com a configuração confiável; as configurações de linter do projeto não são usadas. Só file-size tem prova na suíte padrão: os scanners precisam do smoke com Docker da ponte (imagem do sidecar). | Python 3.11+, imagem Docker do MegaLinter |
| Ruff (`ruff`) | ruff >=0.5.0 | python | lint (adapter-ruff.test.js) | text, structured-read, structured-write | assisted | local, container | testado / ainda não testado / não testado em máquina real | Lê o arquivo de configuração escolhido no tools.yml, senão a resolução própria do Ruff; o runner de container usa só a imagem que o tools prepare fixou no .jgates/lock.json. | Ruff 0.17.2 (pip) ou imagem de container |
| PII (built-in detector) (`builtin-pii`) | quality-sidecar-pii | - | pii (adapter-pii.test.js) | text | editable-file | local | testado / ainda não testado / não testado em máquina real | Detecta CPF, CNPJ e cartão (telefone vem desligado); os achados nunca trazem o valor bruto. | Python 3.11+ (sidecar do JGates) |
| ESLint (`eslint`) | eslint >=9.0.0 | javascript, typescript | lint (adapters-quality.test.js) | text, partial | editable-file | local | testado / ainda não testado / não testado em máquina real | Entra no plano pelos templates só com um eslint.config (typescript-eslint); uma instância declarada sem ele fica bloqueada; a execução roda código do projeto e por isso nunca vem do cache. | ESLint 9+ instalado no projeto |
| Vitest (`vitest`) | vitest >=1.0.0 | javascript, typescript | unit (adapter-vitest.test.js); coverage (adapter-vitest.test.js) | text, partial | editable-file | local | testado / ainda não testado / não testado em máquina real | Só o provedor de cobertura v8, instalado na versão exata do Vitest; o run nunca o instala. | Vitest 1+ e @vitest/coverage-v8 no projeto |
| Semgrep (local rules) (`semgrep`) | semgrep >=1.100.0 | - | sast (adapter-semgrep.test.js) | text | editable-file | local | testado / ainda não testado / não testado em máquina real | Roda só regras locais (sem registry na execução); as regras são preparadas com tools prepare. | Semgrep 1.100+ (pip) |
| pytest (`pytest`) | pytest >=7.0.0 | python | unit (adapter-pytest.test.js); coverage (adapter-pytest.test.js) | text, structured-read, structured-write | assisted | local | testado / ainda não testado / não testado em máquina real | Sem pytest-cov a cobertura não é medida (incompleto, nunca 0%); a execução roda código do projeto. | pytest 7+ e pytest-cov no ambiente do projeto |
| Generic command (`generic-command`) | generic-command | - | - | text | editable-file | local | testado / ainda não testado / não testado em máquina real | Sem capacidade própria: só cobre um requisito com contrato de evidência declarado (código de saída, test runner ou arquivo JSON); os efeitos precisam ser declarados. | O comando que o projeto declara |
| dependency-cruiser (TS/JS architecture) (`dependency-cruiser`) | dependency-cruiser >=16.0.0 | javascript, typescript | architecture (adapter-dependency-cruiser.test.js) | text | editable-file | local | testado / ainda não testado / não testado em máquina real | Lê o grafo de imports; um alias que a ferramenta não resolve é lacuna de cobertura, nunca aprovação. As regras são julgadas pelo JGates a partir do architecture.yml. | dependency-cruiser 16+ (node_modules ou cópia do JGates) |
| Import Linter (Python architecture) (`import-linter`) | import-linter >=2.15.0 <3.0.0 | python | architecture (adapter-import-linter.test.js) | text | editable-file | local | testado / ainda não testado / não testado em máquina real | Exige um contrato (gerado do architecture.yml ou configuração nativa); um import que não resolve é lacuna de cobertura. | import-linter 2.15 (pip) no ambiente do projeto |
| Gitleaks (`gitleaks`) | gitleaks >=8.19.0 <9.0.0 | - | secrets (adapters-security.test.js); secrets-history (adapters-security.test.js) | text | editable-file | container | testado / ainda não testado / não testado em máquina real | Roda só em container; o valor encontrado é mascarado; um relatório cortado ou de outra versão é erro. | Docker e a imagem security-scanners (por digest) |
| Trivy (`trivy`) | trivy >=0.56.0 <1.0.0 | - | dependencies (adapters-security.test.js); iac (adapters-security.test.js); secrets (adapters-security.test.js); licenses (core-followups.test.js) | text | editable-file | container | testado / ainda não testado / não testado em máquina real | Roda só em container; o banco de vulnerabilidades fica em cache na pasta de dados e é registrado com fonte e data. | Docker, a imagem security-scanners e o banco de vulnerabilidades |
| OSV-Scanner (`osv-scanner`) | osv-scanner >=2.0.0 <3.0.0 | - | dependencies (adapters-security.test.js) | text | editable-file | container | testado / ainda não testado / não testado em máquina real | Roda só em container; um achado por grupo de advisory. | Docker e a imagem security-scanners; banco de advisories |
| Checkov (`checkov`) | checkov >=3.0.0 <4.0.0 | - | iac (adapters-security.test.js) | text | editable-file | container | testado / ainda não testado / não testado em máquina real | Roda só em container; as verificações reprovadas viram achados MEDIUM. | Docker e a imagem security-scanners |
| jscpd (duplication) (`jscpd`) | jscpd >=4.0.0 | - | duplication (adapters-quality.test.js) | text | editable-file | local | testado / ainda não testado / não testado em máquina real | Lê a configuração escolhida pelo usuário (binding ou .jscpd.json); uma configuração que não é JSON recusa o plano. | jscpd 5.3.3 (dependência do JGates) |

| Stack | Suporte | Não coberto |
| --- | --- | --- |
| Base (`base`) | completo | - |
| .NET (`dotnet`) | parcial | Build do projeto (dotnet build); Testes do projeto (dotnet test); Cobertura de testes; Analisadores Roslyn e regras do .editorconfig; Typecheck do compilador |
| Go (`go`) | parcial | Build e go vet; Cobertura de testes; Análise de dependências (go.sum); Linters (staticcheck, golangci-lint) |
| Python com Import Linter (`python-import-linter`) | completo | - |
| Python com pytest (`python-pytest`) | completo | - |
| Python e TypeScript (`python-typescript`) | completo | - |
| Python (`python`) | completo | - |
| Rust (`rust`) | parcial | Build (cargo build); clippy; Cobertura de testes; Análise de dependências (cargo audit, cargo deny) |
| TypeScript com dependency-cruiser (`typescript-dependency-cruiser`) | completo | - |
| TypeScript com ESLint (`typescript-eslint`) | completo | - |
| TypeScript com Vitest (`typescript-vitest`) | completo | - |
| TypeScript (`typescript`) | completo | - |
<!-- matrix:end -->
