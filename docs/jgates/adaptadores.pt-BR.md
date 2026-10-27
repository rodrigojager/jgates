# JGates: adaptadores

Um **adaptador** liga o JGates a uma ferramenta de verdade (Ruff, ESLint, pytest, Gitleaks...). Ele diz quais capacidades a ferramenta entrega, como montar o comando, quais arquivos de configuração ela lê e como interpretar o resultado. Uma **instância** é um adaptador aplicado a um componente do projeto (por exemplo `ruff-api`: o Ruff no componente `api`).

A lista de adaptadores, o que cada um entrega, em que sistemas foi testado e a limitação de cada um está na [matriz de compatibilidade](compatibilidade.pt-BR.md). Ela é gerada dos manifestos e das evidências de teste; esta página não repete a tabela.

## Declarar uma instância

As instâncias ficam em `.jgates/tools.yml`, que o `jgates.yml` inclui em `extends`. Cada uma diz o adaptador, o componente, o runner (`local` ou `container`) e o arquivo de configuração que a ferramenta lê:

```yaml
schemaVersion: 1
tools:
  ruff-api:
    adapter: ruff
    component: api
    runner: container
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

## Níveis de suporte

Cada instância mostra o quanto o JGates entende da ferramenta:

| Nível | Significa |
| --- | --- |
| integração completa | A configuração assistida mais a prévia da configuração efetiva; só quando o adaptador declara as duas coisas e tem teste para elas. |
| configuração assistida | O arquivo editável mais um formulário que grava no arquivo (hoje Ruff e pytest). |
| arquivo editável | O JGates conhece o arquivo de configuração e o edita como texto, com validação quando o formato permite. |
| indisponível, incompatível | A ferramenta não foi achada, ou a versão está fora da faixa que o adaptador declara. A etapa sai como bloqueada, nunca como aprovada. |

Uma ferramenta ausente não reprova o código, mas também não o aprova: o plano avisa `TOOL_UNAVAILABLE`, o requisito fica sem prova e o run sai `incomplete` (exit 2).

## Preparar uma ferramenta

O JGates não instala nada por conta própria durante um `run`. A preparação é um passo à parte, com simulação:

```bash
jgates doctor
jgates tools prepare --instance ruff-api --dry-run
jgates tools prepare --instance ruff-api --no-interactive
```

O `--dry-run` mostra versões, a rede que seria usada e o que seria gravado, sem baixar nem gravar. O que foi preparado fica fixado em `.jgates/lock.json`, que vai no repositório: o `run` usa o que foi fixado. Mudar a versão de uma ferramenta já fixada para uma mais antiga exige `--allow-version-change` (`VERSION_DOWNGRADE`).

O `prepare` vale para as instâncias em container (abaixo) e para o Semgrep, cujas regras locais são baixadas uma vez e fixadas por hash. Numa instância local de uma ferramenta que você instala por conta própria (o Ruff do `pip`, por exemplo), ele responde `PREPARE_NOT_SUPPORTED`, e o `jgates doctor` mostra o comando de instalação.

### Ferramentas em container

Uma instância com `runner: container` roda a ferramenta numa imagem, sem rede, com o workspace somente leitura. A imagem é escolhida e fixada pelo `tools prepare`, e o `run` não baixa nada:

```bash
jgates tools prepare --instance ruff-api --image ruff:0.17.2 --dry-run
jgates tools prepare --instance ruff-api --image ruff:0.17.2 --no-interactive
```

`--image` aceita `nome:tag` ou `nome@sha256:...`. Se a imagem não está no runtime, o `prepare` avisa que fará um `docker pull` e em qual host, e num terminal interativo pede a sua confirmação antes. O resultado, com o digest e a versão pelo rótulo da imagem, vai para o `.jgates/lock.json`. Sem `--image`, vale a imagem já fixada no lockfile, senão a do sidecar do JGates. As variáveis `JGATES_*_IMAGE` das versões de desenvolvimento não existem mais: a imagem vive no lockfile, versionada com o projeto.

## O que entra no plano

Ferramentas de configuração própria (ESLint, Vitest, pytest, Import Linter, dependency-cruiser) só entram no plano quando o projeto tem a configuração delas; veja [templates e perfis](templates-e-perfis.pt-BR.md). Uma instância declarada à mão em `.jgates/tools.yml` entra quando a capacidade dela é selecionada, e fica `blocked` se faltar o que ela precisa (por exemplo o ESLint sem `eslint.config`). Isso vale também para quem executa código do projeto (ESLint, Vitest, pytest): o plano mostra o efeito, e o resultado desses nunca é reaproveitado do cache.

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

## Suporte parcial

Go, Rust e .NET têm templates de suporte parcial. Go e Rust: descoberta, configuração explícita e `go test` / `cargo test` pelo comando genérico. .NET: a cadeia atual do flavor `dotnetweb` pela ponte, sem integração própria com build, testes, cobertura nem analisadores. O que cada um **não** cobre aparece no plano (`support.uncovered`) e na [matriz](compatibilidade.pt-BR.md). Nada disso é apresentado como cobertura completa.

## Sistemas operacionais

Linux: testado. Windows: ainda não testado; os testes que dependem do Windows estão marcados e pulam fora dele. macOS: não testado num Mac real. A prova de instalação está em [primeiros passos](primeiros-passos.pt-BR.md).
