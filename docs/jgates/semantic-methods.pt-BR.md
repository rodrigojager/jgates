# JGates: os métodos Semantic

Um método Semantic é um modo revisado de investigar o código com um modelo. Liste-os, com a disponibilidade:

```bash
jgates semantic methods
jgates semantic plan --method general-review
```

`--method <id>` escolhe um (vários, separados por vírgula, cada um roda como sua própria revisão). As telas oferecem a
mesma escolha como caixas de seleção, com Revisão geral marcada por padrão. `--purpose general-review` e
`--purpose security` continuam como atalho para `--method general-review` e `--method security-audit`; com os dois, os
métodos vencem. Um método que precisa de uma entrada que a execução não tem (um patch, um lockfile) é informado como `unavailable` com um
código de motivo (`METHOD_NOT_APPLICABLE` e o código do próprio método), não gasta nenhuma chamada ao modelo e nunca
aparece como favorável.

## Os nove métodos

| Método | Escolhido | O que faz |
| --- | --- | --- |
| `general-review` | por padrão | Seis dimensões (correção, testes, segurança, manutenibilidade, arquitetura, desempenho): planejamento de evidência, caça e uma etapa de contestação; o host decide o que foi examinado e o que está pendente. |
| `security-audit` | sob demanda | A base de auditoria de segurança da Cloudflare: reconhecimento, planejamento de cobertura, caça, crítico de cobertura, refutação por candidato e verificação. |
| `differential-review` | sob demanda | Revisa uma mudança (escopo incremental) pelo que ela quebra. Adaptado da Trail of Bits. |
| `variant-analysis` | sob demanda | Parte de um achado conhecido e procura a mesma causa raiz em outros lugares. Adaptado da Trail of Bits. |
| `insecure-defaults` | sob demanda | Procura configurações padrão inseguras que falham aberto. Adaptado da Trail of Bits. |
| `cross-component` | sob demanda | Raciocina entre fronteiras de componentes e agrupa achados com a mesma causa raiz. Trabalho original do JGates. |
| `property-reasoning` | sob demanda | Enuncia as invariantes de código de limites, autorização e parsing, argumenta cada uma contra o código e propõe testes de propriedade. Trabalho original do JGates. |
| `post-patch-validation` | sob demanda | O reprodutor falha antes de um patch e passa depois? Quem executa é o host, não o modelo. Trabalho original do JGates. |
| `supply-chain-assessment` | sob demanda | Interpreta os sinais de instalação e de procedência dos lockfiles. Trabalho original do JGates. |

## Fontes, versões fixadas e atribuição

- A auditoria de segurança adapta [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill)
  fixado em `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (MIT, Cloudflare, Inc.), incluído em `jgates/vendor/cloudflare-security-audit`.
- Differential review, variant analysis e insecure defaults adaptam [trailofbits/skills](https://github.com/trailofbits/skills)
  fixado em `e4dd0bb5b15535f7c5a0834187dffba6ac37e4ff` (CC-BY-SA-4.0, Trail of Bits), incluído em
  `jgates/vendor/trailofbits-skills`. Os `method.md` adaptados também são CC BY-SA 4.0 (ShareAlike); cada pacote leva sua
  licença, um `NOTICE.md` com as modificações e um registro `jgates-pack.json`.
- As licenças e o restante do que é distribuído estão em `THIRD_PARTY_NOTICES.md`. `jgates tools distribution` confere
  cada pacote distribuído contra o seu registro.

```bash
jgates tools distribution
```

## O que os métodos podem e não podem afirmar

- Um achado confirmado de um método que lê o código leva a base de evidência `source-argument`: o modelo o argumentou a
  partir do código. Nunca é apresentado como reproduzido.
- Nenhum método executa código do projeto no host. A única exceção é `post-patch-validation`, que roda o reprodutor e
  os testes próximos em fixtures isoladas de antes e depois, em contêineres da imagem de ferramentas sem rede (árvore
  somente leitura, sem root, limites de memória, processos e tempo; `jgates regressions validate` roda um teste
  proposto do mesmo jeito); só esse método pode afirmar `reproduced` ou `fixed`, e só quando a execução ocorreu. Sem
  um motor de contêineres utilizável o método não se aplica e nada é afirmado.
- Texto do repositório, saída de scanners e relatórios importados são dados não confiáveis. O acesso a arquivos passa por
  uma guarda do host que recusa exclusões e caminhos fora do escopo; toda recusa é registrada e rebaixa os veredictos
  afetados para `needs-validation`.
- `property-reasoning` e `post-patch-validation` podem propor testes de regressão. Eles só são aplicados por
  `jgates regressions incorporate <id> --approve`.
