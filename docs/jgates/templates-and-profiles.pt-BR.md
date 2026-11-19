# JGates: templates, perfis e seleção

Três coisas decidem o que o JGates verifica: os **templates** (o que cada stack traz), os **perfis** (quanto rigor você quer) e a **seleção** (ligar ou desligar uma verificação em particular, inclusive só numa execução). Tudo vive em arquivos YAML do projeto, versionados com o código.

## As camadas e a origem de cada valor

A configuração final é a soma de camadas, da mais fraca para a mais forte: padrões do JGates, templates, perfil, arquivos do projeto (`jgates.yml` e `.jgates/*.yml`) e as opções da chamada (`--skip`, `--only`, `--profile`...). Para saber de onde veio qualquer valor:

```bash
jgates config resolve --explain
jgates config get /selection/profile
```

`--explain` mostra, por valor, a camada, o arquivo, o caminho dentro dele e o valor anterior. Na interface, o botão de origem ao lado dos campos (`#/config`) mostra a mesma cadeia.

## Templates

Um template é um pacote de configuração para uma stack: ferramentas, exclusões e seleção. O `jgates init` escreve em `jgates.yml` a lista dos que valem para o projeto, cada um com uma ativação:

- `always`: sempre ativo (o `base`);
- `detected`: ativo quando o template casa com o inventário (a linguagem do componente e, em alguns, a presença de um arquivo);
- `manual`: só quando você liga, por exemplo com `--template <id>` numa execução.

Os templates embutidos:

| Template | Para quê |
| --- | --- |
| `base` | Qualquer stack: a ponte com o `quality-gate` (lint, SAST, segredos, dependências, duplicação, IaC, tamanho de arquivo) e a detecção de dados pessoais. |
| `python` | Componentes Python: Ruff e a exclusão de ambientes virtuais e caches. |
| `typescript` | Componentes TypeScript e JavaScript. |
| `python-pytest`, `python-import-linter` | pytest com cobertura, e Import Linter. |
| `typescript-eslint`, `typescript-vitest`, `typescript-dependency-cruiser` | ESLint, Vitest com cobertura, e dependency-cruiser. |
| `gitleaks-history`, `trivy-licenses` | Segredos em todo o histórico do Git e licenças das dependências. Entram por evidência (um repositório Git; um manifesto de dependências) e rodam na imagem dos scanners. |
| `python-mypy-defaults`, `python-mutmut` | mypy nos componentes Python mesmo sem configuração do mypy, e teste de mutação com mutmut. |
| `typescript-stryker` | Teste de mutação de TypeScript e JavaScript com o StrykerJS, quando o projeto tem uma configuração do Stryker. |
| `python-codeql`, `typescript-codeql`, `go-codeql`, `dotnet-codeql` | Análise de fluxo de dados do CodeQL pela linguagem do componente. O CLI do CodeQL é você quem fornece: sem ele, a verificação aparece como indisponível aqui. |
| `python-typescript` | Reúne os de Python e TypeScript para repositórios com os dois. |
| `dotnet`, `go`, `rust` | Suporte parcial: veja [adaptadores](adapters.pt-BR.md). |

### Templates que entram por evidência

ESLint, dependency-cruiser, Import Linter, pytest e Vitest não vêm dentro dos templates `python` e `typescript`. Cada um tem um template próprio que só entra quando o projeto tem a configuração dele (`match.files` no template):

- `typescript-eslint`: um `eslint.config.*` no componente;
- `typescript-vitest`: um `vitest.config.*`, ou um `vite.config.*` com a chave `test:`;
- `python-pytest`: `pytest.ini`, `conftest.py`, ou a seção do pytest no `pyproject.toml`, `tox.ini` ou `setup.cfg`;
- `python-import-linter` e `typescript-dependency-cruiser`: um `.jgates/architecture.yml` (as regras de arquitetura) ou, no Python, a configuração nativa do Import Linter.

Assim o JGates não impõe um framework de testes ou de lint a quem não usa. O `jgates init` grava no `jgates.yml` também os novos acima, como `detected`, e lista todos; o `plan` mostra os que ficaram inativos. Em `jgates.yml` o bloco `templates` é seu: dá para trocar a ativação de um template, ou ligar um `manual`, sem tocar no resto.

## Perfis

Um perfil escolhe as capacidades que contam. Os três embutidos se herdam:

| Perfil | Liga | Herda de |
| --- | --- | --- |
| `minimal` (Essencial) | lint, tamanho de arquivo e segredos | - |
| `standard` (Equilibrado, o padrão do `init`) | mais SAST, dependências, duplicação, IaC e dados pessoais | `minimal` |
| `strict` (Rigoroso) | mais testes unitários e cobertura, obrigatórios; e todas as outras verificações para as quais existe ferramenta, no modo "onde houver ferramenta" (abaixo) | `standard` |

O [catálogo de ferramentas](tools.pt-BR.md) lista os templates implícitos, suas evidências e suas faixas de perfis. A faixa básica entra a partir do Essencial, a principal a partir do Equilibrado e a estendida a partir do Rigoroso, conforme a capacidade e os arquivos encontrados. Em `jgates config`, escolha o perfil e alterne ferramentas individuais. Para selecionar uma ferramenta em uma execução, use `--only tool:<id>`. Depois de uma atualização, o indicador **Verificações novas** identifica as ferramentas adicionadas ao catálogo instalado.

### Obrigatória, onde houver ferramenta ou desligada

Cada capacidade de um perfil tem três modos. Na interface (`#/config`, tela de perfis) o seletor mostra **Obrigatória**, **Onde houver ferramenta** e **Desligada**; no `.jgates/profiles.yml` são `enabled: true`, `enabled: true` com `when: available` e `enabled: false`:

```yaml
checks:
  capability:unit: { enabled: true }
  capability:mutation: { enabled: true, when: available }
```

- **Obrigatória** (`enabled: true`): a verificação precisa rodar. Se o projeto não tem ferramenta para ela, a validação fica bloqueada e diz o que falta (fail-closed: o que você exige nunca é pulado em silêncio).
- **Onde houver ferramenta** (`when: available`): a verificação roda em cada componente que tem uma ferramenta para ela. Onde não há, a capacidade aparece como "não se aplica aqui", com o motivo e a única ação que a ligaria (por exemplo, acrescentar um template, instalar uma ferramenta, preparar a imagem dos scanners), e **nunca bloqueia** o plano nem a decisão.
- **Desligada**: não roda.

O `strict` é montado assim: testes unitários, cobertura e detecção de dados pessoais são obrigatórios; todas as outras capacidades que o catálogo conhece (verificação de formato, segredos no histórico, fluxo de dados, licenças, testes de integração e ponta a ponta, mutação, testes de propriedade, arquitetura, compatibilidade e contrato de API, checagem de tipos, migração, desempenho, CI/CD, cadeia de suprimentos e DAST) são ligadas **onde houver ferramenta**. Um projeto sem ferramenta de mutação vê a mutação como "não se aplica aqui", não como falha e não como uma ausência silenciosa. O plano (`jgates plan`) traz esses itens não aplicáveis numa lista própria; quando a correção é um template embutido, a ação diz qual acrescentar (`add-template`).

A tela de perfis, a tela **Escolher a validação** e a revisão do plano mostram **todas** as capacidades com o estado: "Vai rodar", "Não se aplica aqui" (com o motivo e a ação) ou "Desligada" (com quem desligou: o perfil, o seu arquivo, a política ou só esta execução). A escolha e a revisão marcam as que rodam "só onde houver ferramenta".

O `init` copia os três para `.jgates/profiles.yml`, cada um herdando do embutido (`builtin:minimal`...), e `selection.profile` do `jgates.yml` diz qual vale. Os seus perfis ficam no mesmo arquivo:

```bash
jgates profiles list
jgates profiles create rapido --from standard --skip capability:duplication
jgates profiles set-default rapido
```

`profiles delete <id>` apaga um perfil, e recusa o que é o padrão (`PROFILE_IN_USE`: troque o padrão antes). Cada comando grava por emenda no YAML, preservando comentários, e aceita `--if-match <sha256>` para recusar a gravação se o arquivo mudou desde que você o leu (`REVISION_CONFLICT`). No modo governado, onde a política vem de fora do projeto, os perfis e os limites não são afrouxados: a interface mostra os campos travados.

## Seleção granular

Um seletor aponta para uma parte do catálogo:

| Seletor | Exemplo | O que alcança |
| --- | --- | --- |
| `category:<id>` | `category:security` | Todas as capacidades da categoria (qualidade, segurança, testes, arquitetura, dependências, infraestrutura). |
| `capability:<id>` | `capability:unit` | Uma capacidade, em todas as ferramentas que a entregam. |
| `tool:<id>` | `tool:ruff` | Uma ferramenta (instância ou adaptador). |
| `tool:<id>.<sub>` | `tool:quality-bridge.jscpd` | Uma subverificação de uma ferramenta composta, como a ponte. |
| `pii:<entidade>` | `pii:phone` | Uma entidade da detecção de dados pessoais. |

Quando dois seletores discordam na mesma camada, o mais específico vence (`category` < `capability` < `tool` < regra). Se empatam, vale ligado: na dúvida, roda mais verificação. Um seletor que não casa com nada é erro (`SELECTOR_UNMATCHED`), com sugestão do nome mais próximo.

## Desligar só nesta execução

`--skip` desliga e `--only` restringe (`plan` e `run` aceitam os dois; `config resolve` aceita `--skip`). Os valores valem só para aquela chamada, não gravam nada, e podem ser repetidos ou separados por vírgula:

```bash
jgates plan --skip capability:unit --skip pii:phone
jgates plan --only category:security
jgates run --profile standard --skip capability:duplication
```

O plano mostra cada item afetado com a origem "só esta execução". Quando o que você desligou é exigido pelo perfil, o resultado sai com `reduced: true` e a decisão nunca vale como aprovação do perfil completo: um agente que corrige código não encerra o ciclo assim. O que precisa mudar de verdade é o perfil, e isso é uma revisão do plano.

Na interface, a tela Escolher (`#/validations/choose`) tem o painel "Personalizar esta validação", que faz o mesmo, e a revisão do plano (`#/validations/review`) mostra o resultado antes de executar.

## Salvar uma execução como perfil

Uma seleção que você gostou vira perfil sem escrever YAML: ou parte de um perfil existente com os desligamentos (`profiles create ... --from ... --skip ...`, acima), ou parte de um run que já aconteceu, com o perfil mais os desligamentos daquela execução:

```bash
jgates history
jgates profiles save --run <runId> --as rapido
```

O `save` recusa um run que não existe (`RUN_NOT_FOUND`) e um run que usou `--only` (`RUN_USED_ONLY`: uma restrição não vira perfil; rode de novo com `--skip` nos itens a desligar). Na interface o mesmo é o botão "Salvar como perfil".
