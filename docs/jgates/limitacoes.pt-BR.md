# JGates: limitações conhecidas

Esta página junta o que o JGates ainda não faz, o que não foi testado e os controles que a interface mostra como indisponíveis. Cada item foi conferido contra o código desta versão. Se um item não está aqui, não significa que funciona: significa que ninguém o registrou.

## O que não foi testado

- **macOS.** Nenhum teste rodou em um Mac real. A matriz de compatibilidade mostra "não testado em máquina real" na coluna do macOS para todos os adaptadores. O caminho da pasta de dados no macOS (`~/Library/Application Support/jgates`) existe no código e é coberto só por teste de unidade.
- **Windows.** A suíte automática roda no Linux; o JGates ainda não rodou no Windows. Os testes que dependem do Windows estão marcados e pulam fora dele, com o motivo; os que exigem POSIX (permissões `0600`, cancelamento por grupo de processos, symlinks) não têm equivalente lá. Antes de confiar no JGates no Windows, rode a suíte nessa máquina (`node scripts/smoke-install.mjs` repete a prova de instalação).
- **Leitor de tela.** A acessibilidade foi verificada com o axe (WCAG 2.2 AA, sem violação crítica ou séria nos temas claro, escuro e do sistema), com o teclado e com redução de movimento. Nenhum leitor de tela real foi usado.
- **Instalação direta do GitHub.** O `npm install --prefix <pasta> git+https://github.com/rodrigojager/jgates` e o `npm install git+https://github.com/rodrigojager/jgates` dentro de um projeto foram verificados à mão com um clone local (`git+file://`, npm 11), inclusive numa pasta com espaço no caminho: `jgates --version` e `jgates doctor --json` funcionaram. Não estão na suíte automática, e o download pelo GitHub em si não foi exercitado. O caminho testado pela suíte é o tarball de `npm pack` (veja [primeiros passos](primeiros-passos.pt-BR.md)).

## Instalação global a partir do GitHub

O `npm install --global git+https://github.com/rodrigojager/jgates` **não funciona**. O problema é do npm, não do JGates: numa instalação global de uma dependência git, o npm liga o pacote global a um clone temporário no cache dele e depois apaga esse clone, e os comandos `jgates`, `quality-gate` e `semantic-gate` ficam apontando para nada. Acontece também com `--allow-scripts`. O passo `prepare` do JGates termina sem erro nesse caso. No lugar, use uma destas formas:

- numa pasta própria: `npm install --prefix <pasta> git+https://github.com/rodrigojager/jgates`, com `<pasta>/node_modules/.bin` no `PATH`;
- dentro de um projeto: `npm install git+https://github.com/rodrigojager/jgates`, e os comandos com `npx`;
- global: `npm pack` num clone, seguido de `npm install --global ./jgates-<versão>.tgz`.

## Semantic gate

O semantic gate é opcional e está descrito em [semantic gate](semantic-gate.pt-BR.md). Todos os testes usam um provider falso, para não gastar tokens. O **smoke com um provider real está pendente**: nenhuma revisão real foi feita de ponta a ponta com uma chave verdadeira. O comportamento diante de timeout, orçamento esgotado e provider indisponível é coberto pelo provider falso.

## Licenças

O `THIRD_PARTY_NOTICES.md` (na raiz do repositório) lista cada componente. Para quem distribui uma imagem ou um pacote, importam estes pontos:

- **MegaLinter é AGPL-3.0.** A imagem do sidecar parte da imagem do MegaLinter. Ela roda como processo separado, sem ligação com o JGates, mas redistribuir a imagem exige a oferta do código-fonte e o texto da licença do MegaLinter e das ferramentas que ele embute.
- **Regras do registry do Semgrep** têm a Semgrep Rules License v1.0, que restringe o uso a fins internos de negócio. O JGates não as distribui; um projeto que as ativa aceita esses termos.
- **Bases de vulnerabilidades.** O banco do Trivy e os dados do OSV.dev têm termos próprios e são baixados na execução, nunca guardados no repositório.
- **Licenças não conferidas offline.** As licenças dos scanners das imagens (Gitleaks, Trivy, OSV-Scanner, Checkov, editorconfig-checker, ls-lint, protolint e outros) vêm do que o projeto de origem declara e estão marcadas como "upstream, não conferido offline" no `THIRD_PARTY_NOTICES.md`. Confira o `LICENSE` de origem antes de redistribuir uma imagem.
- `axe-core` e `@axe-core/playwright` são MPL-2.0 e só servem aos testes; não entram no `dist/`.

## Controles marcados como indisponíveis na interface

Alguns controles gravam o valor no arquivo, mas o motor ainda não o lê. A interface não os esconde: marca cada um com o atributo `data-control-unavailable` e mostra o motivo no campo. São:

- `execution.runner` (Configuração, Execução): o runner de cada instância vem do vínculo da ferramenta, e o plano não tem onde receber um padrão sem mudar o hash.
- Os quatro limites de `execution.budgets.*` (Configuração, Execução): gravados, não aplicados.
- `security.block-from` (Configuração, Perfis, política): o bloqueio por severidade é decidido na ponte do quality-gate, que não lê essa regra.
- `missing-check.block` (Configuração, Perfis, política): idem para o bloqueio por verificação ausente.

O que já vale: `execution.failFast` (age como `--fail-fast`) e `coverage.minimum`, com um mínimo por componente.
## Resultado e interface

- **Filtro por componente nos achados.** A lista de achados da tela de resultado só mostraria um filtro por componente se algum achado tivesse `component`; o `finding` do `result.json` não tem esse campo (só as métricas têm), então o filtro nunca aparece. Incluí-lo exige um campo novo no resultado e o preenchimento pelos adaptadores.
- **Modo governado detectado por variável.** A interface sabe que o modo é governado pela variável `JGATES_POLICY_DIR` no ambiente do servidor. Nesse modo os campos ficam bloqueados e as rotas de gravação respondem 403 `GOVERNED_LOCKED`.
- **Dois bloqueios da revisão do plano só na interface.** Um template obrigatório sem componente e uma ferramenta ou arquitetura indisponível bloqueiam o botão de executar, mas a CLI e `POST /api/runs` ainda aceitam o plano.
- **Gravação em lote.** A área da ferramenta grava um arquivo por vez.
- **Modo política.** Com `jgates ui --policy <pasta>` a interface edita a pasta da política de CI; as telas que validam um projeto (plano e execução) ficam indisponíveis nesse modo (409 `POLICY_MODE_UNAVAILABLE`).

## CI

- **Escopo do `jgates ci`.** Os scanners nativos (gitleaks, trivy, osv-scanner, checkov, jscpd, dependency-cruiser, import-linter) ficam fora do `jgates ci`: a ponte do quality gate, endurecida, os cobre. Do MegaLinter rodam só os linters verificados, listados em `quality-gate/sidecar/config/megalinter-linters.json`.
- **Resultados autodeclarados.** Ferramentas que executam código do projeto produzem resultado `selfReported`, que só aprova se a política confiar nele (`execution.trustSelfReported`, padrão `false`).
- **Ativação nos templates da política.** No repositório de políticas, use ativação `always`; a ativação por arquivo deixa o projeto ligar ou desligar a ferramenta.
- **Não há prova em pipelines reais.** Os exemplos de `examples/ci` são testados como texto e pelo comando; nenhum pipeline do GitHub ou do GitLab os executou de ponta a ponta.

## Adaptadores e ponte

- **Ponte (quality-bridge).** Das nove capacidades da ponte, oito estão como `declared` (declarada, sem prova) na matriz: só `file-size` tem teste na suíte padrão. As demais precisam do smoke com Docker da imagem do sidecar, que não foi feito.
- **Trivy.** O cache cobre só o banco de vulnerabilidades; a base Java e o pacote de verificações ainda são baixados a cada execução.
- **ESLint em monorepo.** O ESLint dos templates roda na raiz do workspace, não na pasta de cada componente.
- **Go, Rust e .NET** têm suporte parcial; a lista do que não é coberto está na matriz de [compatibilidade](compatibilidade.pt-BR.md).

## Relacionados

[Segurança](seguranca.pt-BR.md) · [problemas comuns](problemas.pt-BR.md)
