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
| `python-typescript` | Reúne os de Python e TypeScript para repositórios com os dois. |
| `dotnet`, `go`, `rust` | Suporte parcial: veja [adaptadores](adaptadores.pt-BR.md). |

### Templates que entram por evidência

ESLint, dependency-cruiser, Import Linter, pytest e Vitest não vêm dentro dos templates `python` e `typescript`. Cada um tem um template próprio que só entra quando o projeto tem a configuração dele (`match.files` no template):

- `typescript-eslint`: um `eslint.config.*` no componente;
- `typescript-vitest`: um `vitest.config.*`, ou um `vite.config.*` com a chave `test:`;
- `python-pytest`: `pytest.ini`, `conftest.py`, ou a seção do pytest no `pyproject.toml`, `tox.ini` ou `setup.cfg`;
- `python-import-linter` e `typescript-dependency-cruiser`: um `.jgates/architecture.yml` (as regras de arquitetura) ou, no Python, a configuração nativa do Import Linter.

Assim o JGates não impõe um framework de testes ou de lint a quem não usa. O `jgates init` lista todos como `detected`; o `plan` mostra os que ficaram inativos. Em `jgates.yml` o bloco `templates` é seu: dá para trocar a ativação de um template, ou ligar um `manual`, sem tocar no resto.

## Perfis

Um perfil escolhe as capacidades que contam. Os três embutidos se herdam:

| Perfil | Liga | Herda de |
| --- | --- | --- |
| `minimal` (Essencial) | lint, tamanho de arquivo e segredos | - |
| `standard` (Equilibrado, o padrão do `init`) | mais SAST, dependências, duplicação, IaC e dados pessoais | `minimal` |
| `strict` (Rigoroso) | mais testes unitários e cobertura | `standard` |

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
