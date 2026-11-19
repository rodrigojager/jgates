# JGates: adaptadores

Um **adaptador** liga o JGates a uma ferramenta de verdade (Ruff, ESLint, pytest, Gitleaks...). Ele diz quais capacidades a ferramenta entrega, como montar o comando, quais arquivos de configuração ela lê e como interpretar o resultado. Uma **instância** é um adaptador aplicado a um componente do projeto (por exemplo `ruff-api`: o Ruff no componente `api`).

A lista de adaptadores, o que cada um entrega, em que sistemas foi testado e a limitação de cada um está na [matriz de compatibilidade](compatibility.pt-BR.md). Ela é gerada dos manifestos e das evidências de teste; esta página não repete a tabela.

## Declarar uma instância

As instâncias ficam em `.jgates/tools.yml`, que o `jgates.yml` inclui em `extends`. Cada uma diz o adaptador, o componente e o arquivo de configuração que a ferramenta lê. Toda instância roda na imagem de ferramentas do JGates (não há runner a escolher; uma chave `runner` antiga é ignorada com um aviso):

```yaml
schemaVersion: 1
tools:
  ruff-api:
    adapter: ruff
    component: api
    config: api/pyproject.toml
```

O `config` é sempre um caminho dentro do workspace (ou de uma raiz externa declarada); um caminho que escapa dele é recusado.

## Ver o que existe

```bash
jgates tools list
jgates tools inspect ruff-api
jgates tools matrix
```

`tools list` mostra as categorias, as capacidades, os adaptadores e as instâncias declaradas em `.jgates/tools.yml`. `tools inspect` mostra uma instância com os arquivos vinculados. `tools matrix` imprime a matriz de compatibilidade (e `--json` traz os problemas que o teste de consistência verifica).

Os linters integrados usam evidências nos arquivos, como extensão, nome ou marcador de configuração. O descritor define o comando, o leitor da saída, a faixa de perfis e a classificação de confiança no CI. Cada ferramenta roda na imagem de ferramentas do JGates. [Consulte o catálogo de ferramentas](tools.pt-BR.md).

## Níveis de suporte

Cada instância mostra o quanto o JGates entende da ferramenta:

| Nível | Significa |
| --- | --- |
| integração completa | A configuração assistida mais a prévia da configuração efetiva; só quando o adaptador declara as duas coisas e tem teste para elas. |
| configuração assistida | O arquivo editável mais um formulário que grava no arquivo (hoje Ruff e pytest). |
| arquivo editável | O JGates conhece o arquivo de configuração e o edita como texto, com validação quando o formato permite. |
| indisponível, incompatível | A ferramenta não foi achada, ou a versão está fora da faixa que o adaptador declara. A etapa sai como bloqueada, nunca como aprovada. |

Uma ferramenta ausente não reprova o código, mas também não o aprova: o plano avisa `TOOL_MISSING` (uma ferramenta que a imagem de ferramentas não tem, com a imagem como a única ação) ou `TOOL_UNAVAILABLE`, o requisito fica sem prova e o run sai `incomplete` (exit 2).

## De onde vêm as ferramentas

Toda ferramenta vem da imagem de ferramentas do JGates, cujo `image.json` diz quais ferramentas e versões ela tem; o JGates nunca instala uma ferramenta na sua máquina. O `jgates doctor` mostra o motor de containers, a imagem de ferramentas e a ferramenta de cada instância. Uma ferramenta que a imagem não tem é `TOOL_MISSING`, resolvida pela imagem de ferramentas desta versão do JGates, nunca por uma instalação na máquina.

## Preparar os dados de uma instância

Algumas instâncias precisam de dados antes de rodar. A preparação é um passo à parte, com simulação:

```bash
jgates doctor
jgates tools prepare --instance <instance> --dry-run
jgates tools prepare --instance <instance> --no-interactive
```

O `--dry-run` mostra versões, a rede que seria usada e o que seria gravado, sem baixar nem gravar. O que foi preparado fica fixado em `.jgates/lock.json`, que vai no repositório: o `run` usa o que foi fixado. Mudar a versão de uma ferramenta já fixada para uma mais antiga exige `--allow-version-change` (`VERSION_DOWNGRADE`).

O `prepare` vale para o Semgrep, cujas regras locais são baixadas uma vez e fixadas por hash. Em qualquer outra instância ele responde `PREPARE_NOT_SUPPORTED`.

O adaptador do Semgrep também pode rodar o pacote de regras do JGates (`tools.<id>.rulePack: jgates`, o padrão do template base): regras originais para JavaScript, TypeScript, Python, Go, C#, Rust, Java e PHP. O item do plano nomeia as linguagens que o pacote cobre e, quando a descoberta achou uma linguagem para a qual o pacote não tem regra, avisa isso como limitação. A etapa do Semgrep no resultado traz `scannedLanguages`, o número de arquivos de cada linguagem que a varredura cobriu. Para Java e PHP, que não têm stack, o pacote é a única verificação específica da linguagem.

### A ponte de qualidade foi aposentada

A ponte do quality-gate (o MegaLinter e a imagem do sidecar) não participa mais dos planos. Cada scanner é uma instância do próprio adaptador, executada na imagem de ferramentas: Semgrep (`sast`), Gitleaks (`secrets`), OSV-Scanner e Trivy (`dependencies`), Trivy e Checkov (`iac`), jscpd (`duplication`) e file-size (`file-size`) vêm do template base; o lint vem do linter de cada stack (Ruff, ESLint, golangci-lint, Clippy, os analisadores do .NET, ShellCheck, Hadolint) e os testes e a cobertura do executor de testes de cada stack. Nenhuma imagem de MegaLinter ou de sidecar é iniciada.

- Um `.jgates/tools.yml` que ainda declara uma instância do adaptador `quality-bridge` é lido como as instâncias individuais que cobrem as mesmas capacidades; o arquivo em disco não é reescrito, e a visão geral mostra um aviso que nomeia as instâncias. As verificações de um perfil que citam `tool:quality-bridge.<subverificação>` são lidas como o seletor da instância que assumiu a subverificação.
- O `jgates ci` (modo governado) continua lendo as subverificações da ponte do quality-gate legado, com a configuração empacotada e confiável; os scanners dos adaptadores individuais que leem configuração da árvore analisada não são permitidos sob uma política.
- Um projeto sem linter para a sua stack mostra o lint como não aplicável aqui, com o que adicionar (por exemplo uma configuração do ESLint), em vez de um plano bloqueado.

## O que entra no plano

Ferramentas de configuração própria (ESLint, Vitest, pytest, Import Linter, dependency-cruiser) só entram no plano quando o projeto tem a configuração delas; veja [templates e perfis](templates-and-profiles.pt-BR.md). Uma instância declarada à mão em `.jgates/tools.yml` entra quando a capacidade dela é selecionada, e fica `blocked` se faltar o que ela precisa (por exemplo o ESLint sem `eslint.config`). Isso vale também para quem executa código do projeto (ESLint, Vitest, pytest): o plano mostra o efeito, e o resultado desses nunca é reaproveitado do cache.

## Comando genérico

Para uma verificação sem adaptador (um script do time, `go test`, `cargo test`), o adaptador `generic-command` executa um comando explícito, sem shell. Ele não ganha crédito por rodar: precisa **declarar os efeitos** e um **contrato de evidência** que diga o que o resultado prova. Sem efeitos declarados o plano não é aprovável.

Ele é declarado num template do projeto, em `.jgates/templates/api-unittest.yml`:

```yaml
schemaVersion: 1
id: api-unittest
label: Testes unittest da API
extends: [builtin:base]
config:
  tools:
    api-unittest:
      adapter: generic-command
      enabled: true
      capabilities: [unit]
      command: python
      args: [-m, unittest, discover, -s, "{workspace}/api"]
      config:
        support: partial
        limitations:
          - Roda só o unittest, sem cobertura.
        effects: { readsCode: true, writesOutputs: false, mayChangeCode: false, executesProjectCode: true, usesNetwork: false }
        evidence: { kind: exit-code }
```

E ligado em `jgates.yml`:

```yaml
templates:
  - id: api-unittest
    source: .jgates/templates/api-unittest.yml
    activation: always
```

Os contratos de evidência: `exit-code` (o código de saída decide), `test-runner` (`go-test` ou `cargo-test`: o JGates lê a saída do executor) e `json-file` (o comando grava um JSON que o JGates valida contra um schema do workspace). Segurança e arquitetura só são creditadas com `json-file`; testes, com `json-file` ou `test-runner`. Com `exit-code` o requisito de segurança, arquitetura ou testes continua `EVIDENCE_MISSING` (sem cobertura, plano não aprovável). `support` e `limitations` aparecem no plano e no resultado.

## Stacks e suas próprias ferramentas

Go, Rust e .NET têm templates próprios para lint, build, testes e dependências; o que cada stack **não** cobre aparece no plano (`support.uncovered`) e na [matriz](compatibility.pt-BR.md). Nada disso é apresentado como cobertura completa. Para uma ferramenta ou uma linguagem que o JGates não traz, adicione [sua própria ferramenta](extension.pt-BR.md): ela roda numa imagem estendida da imagem de ferramentas e é lida por relatórios SARIF, JUnit ou Checkstyle (`evidence.kind`). As verificações que precisam de uma aplicação ou de um banco de dados em execução usam os [serviços do projeto](services.pt-BR.md).

## Sistemas operacionais

Toda ferramenta roda num contêiner `linux/amd64`. Linux: testado. Windows: o fluxo do primeiro uso foi conferido à mão no Windows 10 com Docker Desktop (veja [limitações](limitations.pt-BR.md)); os testes que dependem do Windows estão marcados e pulam fora dele. macOS: não testado num Mac real. A prova da instalação está em [primeiros passos](getting-started.pt-BR.md).
