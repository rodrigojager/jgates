# JGates: limitações conhecidas

Esta página reúne o que o JGates ainda não faz, o que não foi testado e os controles que a interface mostra como indisponíveis. Cada item foi conferido contra o código desta versão. Um item que não está aqui não significa que funciona: significa que ninguém o registrou.

## O que o desenho com contêineres não cobre

- **Só `linux/amd64`.** A imagem de ferramentas e todo passo são Linux em amd64. Um motor que roda outra plataforma (um motor arm64, por exemplo) é apontado como `UNSUPPORTED_PLATFORM`. Nada foi feito para computadores macOS ou arm64.
- **Um motor de contêineres é obrigatório.** Não existe modo que rode as verificações no computador. Se não há motor instalado ou ele está parado, o JGates diz isso (`ENGINE_NOT_INSTALLED`, `ENGINE_STOPPED`) e as verificações não rodam; nunca saem como aprovadas. A exceção é o JGates rodando dentro da própria imagem de ferramentas (num job de CI cujo contêiner é essa imagem).
- **As ferramentas de correção de dados pessoais do cliente ainda rodam no computador.** As ferramentas que você declara no `.jgates/pii.yml` para o `jgates pii fix` são programas seus, e rodam na sua máquina, sobre uma cópia temporária dos arquivos, com o protocolo descrito em [segurança](security.pt-BR.md#dados-pessoais-nos-arquivos-do-projeto). Só o detector embutido do JGates roda na imagem de ferramentas.
- **O CodeQL não vem junto.** Os termos dele não permitem redistribuição. Você os aceita e o prepara com `jgates tools prepare-codeql`; até lá a capacidade `dataflow` fica `incomplete`. Nenhum CodeQL real roda nos testes do JGates, então toda linha do CodeQL na matriz é `customer-setup-required`.
- **O espelho do OSV cobre só npm, PyPI, Go, crates.io e NuGet.** Uma dependência de outro ecossistema não é coberta pelos dados offline do OSV; não leia um resultado limpo como prova para ela.
- **O Trivy usa as verificações embutidas.** O pacote de verificações que o Trivy baixaria não é usado; valem as verificações de configuração que vêm dentro do binário, com a base de vulnerabilidades do volume `jgates-data`.
- **Os testes e2e do Playwright rodam só no Chromium.** Os navegadores da versão do Playwright do projeto são buscados no volume de toolchains, e o JGates busca o Chromium; projetos de Firefox e WebKit não são executados.
- **O primeiro download é grande.** A imagem tem cerca de 5 GB para baixar e uns 13 GB descompactada, mais as dependências de cada projeto e as bases de vulnerabilidades. Veja [armazenamento e limpeza](storage.pt-BR.md).
- **Os scripts de instalação rodam, mas no contêiner.** O passo de dependências executa os scripts de instalação dos pacotes (`postinstall` do npm, backends de build do Python) dentro do contêiner, com a rede ligada. Eles não alcançam o seu projeto nem a sua máquina, mas rodam, e a revisão diz isso. Veja [segurança](security.pt-BR.md#caches-compartilhados-e-scripts-de-instalação).
- **Maiúsculas e minúsculas.** A cópia do projeto no volume diferencia maiúsculas de minúsculas, como no Linux. Um projeto que só funciona num sistema de arquivos que não diferencia falha no contêiner (veja [problemas comuns](troubleshooting.pt-BR.md#windows-e-wsl)).

## O que não foi testado

- **macOS.** Nenhum teste rodou num Mac real. A matriz de compatibilidade mostra "não testado em máquina real" na coluna do macOS para todos os adaptadores. O caminho da pasta de dados no macOS (`~/Library/Application Support/jgates`) existe no código e é coberto só por um teste unitário.
- **Windows.** A suíte automática roda no Linux. Numa máquina com Windows 10 e Docker Desktop, o fluxo do primeiro uso foi conferido à mão: a instalação global a partir do tarball do `npm pack` (com o `jgates` no `Path`), `init`, `plan`, `run` e `ui`. A própria suíte ainda tem falhas próprias no Windows (caminhos comparados com caixa de letras diferente, verificações que exigem POSIX: permissões `0600`, cancelamento por grupo de processos, links simbólicos); os testes que dependem do Windows estão marcados e pulam fora dele, com o motivo. O comando `winget` da receita do Docker não foi executado. Antes de confiar no JGates em outra máquina Windows, rode a suíte lá (o `node scripts/smoke-install.mjs` repete a prova de instalação).
- **Motores que não são o Docker.** As verificações usam a linha de comando do Docker. Espera-se que o Rancher Desktop e o Podman Desktop funcionem pelo comando `docker` deles ou por `JGATES_CONTAINER_RUNTIME`, mas só o Docker foi exercitado.
- **Leitor de tela e novas telas Revisar.** As verificações anteriores de acessibilidade usaram axe (WCAG 2.2 AA, nenhuma violação crítica ou séria nos temas claro, escuro e do sistema), teclado e movimento reduzido. Nenhum leitor de tela real foi usado. Os novos controles Revisar passaram só pela verificação de tipos da interface; a verificação real de teclado/Esc, tema, idioma, responsividade e axe continua pendente.
- **Instalação direta do GitHub.** `npm install --prefix <pasta> git+https://github.com/rodrigojager/jgates` e `npm install git+https://github.com/rodrigojager/jgates` dentro de um projeto foram conferidos à mão com um clone local (`git+file://`, npm 11), inclusive numa pasta com espaço no caminho: `jgates --version` funcionou. Não estão na suíte automática, e o download do próprio GitHub não foi exercitado. O caminho que a suíte testa é o tarball do `npm pack` (veja [primeiros passos](getting-started.pt-BR.md)).
- **A imagem de ferramentas ainda não foi publicada.** Até lá, o arquivo de pin guarda a imagem local `jgates-tools:dev`; o `jgates tools export` e o `import` levam uma imagem entre máquinas.

## Instalação global pelo GitHub

O `npm install --global git+https://github.com/rodrigojager/jgates` **não funciona**. O problema é do npm, não do JGates: numa instalação global de uma dependência git, o npm liga o pacote global a um clone temporário no cache dele e depois apaga esse clone, então os comandos `jgates`, `quality-gate` e `semantic-gate` apontam para o nada. Acontece também com `--allow-scripts`. O passo `prepare` do JGates termina sem erro nesse caso. Use uma destas formas:

- numa pasta própria: `npm install --prefix <pasta> git+https://github.com/rodrigojager/jgates`, com `<pasta>/node_modules/.bin` no `PATH`;
- dentro de um projeto: `npm install git+https://github.com/rodrigojager/jgates`, e os comandos pelo `npx`;
- global: `npm pack` num clone, seguido de `npm install --global ./jgates-<versão>.tgz`.

## Verificações de Java e PHP

A presença de arquivos ativa o PMD para Java e o PHPStan para PHP nos perfis Equilibrado e Rigoroso. O Rigoroso também pode executar outras ferramentas para esses dois casos quando os arquivos e as configurações necessários estiverem presentes. Consulte o [catálogo de ferramentas](tools.pt-BR.md) para saber como cada ferramenta entra e quais são suas limitações. O Semgrep fornece SAST no Equilibrado e no Rigoroso. Java e PHP ainda precisam de executores de testes por componente, coleta de cobertura e preparo de dependências dedicados. Os dados de avisos offline não cobrem Maven nem Composer.

## Limites de Revisar e das notas de linguagem

As quatro classes do pacote são `ERROR`, `WARNING`, `INFO` comum e **Revisar**. Achados Revisar aparecem em **Para revisar**,
nunca bloqueiam em nenhum perfil ou modo, nunca mudam o código de saída e nunca examinam um requisito ASVS.
Revisar detecta uma proteção não visível localmente, não uma vulnerabilidade demonstrada: pode deixar passar código
arriscado e apontar código seguro com mais frequência que uma regra bloqueante. Proteções podem estar em outro lugar,
e a biblioteca ou sua configuração podem diferir do modelo. **Marcar como revisado** registra uma dispensa por ocorrência,
não uma aprovação de segurança; Revisar sozinho nunca muda o resultado para "aprovado com N dispensas".

Uma nota de linguagem é uma afirmação revisada sobre uma biblioteca ou linguagem, não uma verificação do projeto.
Nem "Protegido pela própria biblioteca (não verificado pelo JGates)" nem "Não se aplica a esta linguagem" muda um estado
ASVS, conta como examinado ou registra o seu "não se aplica". Veja [o mapa](asvs-coverage.pt-BR.md).

### Lacuna de detecção de imports mistos de templates Go

`jgates.go.text-template-for-html` não detecta um `import "text/template"` sem nome ao lado de um import nomeado de
`html/template`, como `import htmltpl "html/template"`. Seu ramo de import sem nome exclui explicitamente arquivos com
um import nomeado de templates HTML. Tentativas locais de remover ou estreitar essa exclusão detectaram as chamadas
inseguras, mas também apontaram incorretamente templates seguros `htmltpl` executados numa resposta HTTP. A regra,
portanto, continua bloqueante e inalterada; esse formato de imports mistos é uma lacuna documentada, não uma detecção corrigida.

### Lacuna de verificação de certificado de cliente em Rust

Não existe a regra `jgates.rust.mtls-client-certificate-not-verified`. Na API OpenSSL modelada, PEER pede e verifica o
certificado, NONE não pede um, e um callback de verificação que aceita tudo é um desvio explícito, não Revisar por proteção
ausente. Nenhuma verificação executável nem cobertura examinada é atribuída a essa omissão planejada.

## Semantic gate

O semantic gate é opcional, continua no computador e está descrito em [semantic gate](semantic-gate.pt-BR.md). Todo teste usa um provider falso, para não gastar tokens. O **smoke com um provider real está pendente**: nenhuma revisão real foi executada de ponta a ponta com uma chave real. O comportamento em timeout, orçamento esgotado e provider indisponível é coberto pelo provider falso.

## Licenças

O `THIRD_PARTY_NOTICES.md` (na raiz do repositório) lista todos os componentes. Para quem distribui uma imagem ou um pacote, estes pontos importam:

- **A imagem do sidecar antigo é AGPL-3.0.** O sidecar do quality gate antigo parte da imagem do MegaLinter. O JGates não a constrói mais nem a usa nos planos do `jgates run`, mas o comando `quality-gate` ainda usa essa camada; o `jgates ci` roda dentro da imagem de ferramentas, que não tem o MegaLinter. Ela roda como um processo separado, não ligado ao JGates, mas redistribuir essa imagem exige a oferta do código-fonte e o texto da licença do MegaLinter e das ferramentas que ele embute.
- **As regras do registro do Semgrep** têm a Semgrep Rules License v1.0, que restringe o uso a fins comerciais internos. A imagem de ferramentas não as contém e o JGates não as distribui; um projeto que as ativa aceita esses termos.
- **Bases de vulnerabilidades.** A base do Trivy e os dados do OSV.dev têm termos próprios e são baixados para um volume quando você roda `jgates setup` ou `jgates tools update-data`, nunca guardados no repositório.
- **O CodeQL** está sob os termos do GitHub, que você aceita ao prepará-lo.
- **Licenças não verificadas offline.** As licenças dos scanners nas imagens (Gitleaks, Trivy, OSV-Scanner, Checkov, editorconfig-checker, ls-lint, protolint e outros) vêm do que o projeto de origem declara e estão marcadas como "upstream, não reverificada offline" no `THIRD_PARTY_NOTICES.md`. Confira o `LICENSE` de origem antes de redistribuir uma imagem.
- `axe-core` e `@axe-core/playwright` são MPL-2.0 e servem só aos testes; não entram no `dist/`.

## Controles marcados como indisponíveis na interface

Alguns controles gravam o valor no arquivo, mas o motor ainda não o lê. A interface não os esconde: marca cada um com o atributo `data-control-unavailable` e mostra o motivo no campo. São eles:

- `execution.runner` (Configuração, Execução): o runner de cada instância vem do binding da ferramenta, e o plano não tem onde receber um padrão sem mudar o hash.
- Os quatro limites `execution.budgets.*` (Configuração, Execução): gravados, não aplicados.
- `security.block-from` (Configuração, Perfis, política): o bloqueio por severidade é decidido na ponte do quality gate, que não lê essa regra.
- `missing-check.block` (Configuração, Perfis, política): o mesmo para bloquear por verificação ausente.

O que já funciona: `execution.failFast` (age como `--fail-fast`), `execution.dataMaxAgeDays` e `coverage.minimum`, com um mínimo por componente. Sem `coverage.minimum`, o `fail_under` do próprio componente (`.coveragerc`, `pyproject.toml`, `setup.cfg` ou `tox.ini`) é o mínimo.

## Resultado e interface

- **Filtro por componente nos achados.** A lista de achados da tela de resultado só mostraria um filtro por componente se algum achado tivesse `component`; o `finding` do `result.json` não tem esse campo (só as métricas têm), então o filtro nunca aparece. Acrescentá-lo exige um campo novo no resultado e os adaptadores preenchendo-o.
- **Modo governado detectado por variável.** A interface sabe que o modo é governado pela variável `JGATES_POLICY_DIR` no ambiente do servidor. Nesse modo os campos ficam travados e as rotas de escrita respondem 403 `GOVERNED_LOCKED`.
- **Dois bloqueios da revisão do plano só na interface.** Um template obrigatório sem componente e uma ferramenta ou arquitetura indisponível bloqueiam o botão de executar, mas a CLI e o `POST /api/runs` ainda aceitam o plano.
- **Salvar em lote.** A área de uma ferramenta salva um arquivo por vez.
- **Modo política.** Com `jgates ui --policy <pasta>` a interface edita a pasta da política de CI; as telas que validam um projeto (plano e execução) ficam indisponíveis nesse modo (409 `POLICY_MODE_UNAVAILABLE`).

## CI

- **Escopo do `jgates ci`.** O `jgates ci` roda dentro do contêiner do job (a imagem de ferramentas, fixada por digest). Os scanners que leem configuração ou arquivos de ignorar da árvore analisada ficam de fora, e a camada da ponte do quality gate antigo, com a configuração empacotada e confiável, os cobre. O MegaLinter não roda ali: a imagem de ferramentas não o tem, e a subverificação `megalinter` da ponte fica sempre desligada, substituída pelos linters que são ferramentas próprias do JGates.
- **Resultados autodeclarados.** Ferramentas que executam código do projeto produzem um resultado `selfReported`, que só aprova se a política confiar nele (`execution.trustSelfReported`, padrão `false`).
- **Ativação nos templates da política.** No repositório da política use a ativação `always`; a ativação por arquivo deixa o projeto ligar ou desligar a ferramenta.
- **Sem prova em pipelines reais.** Os exemplos em `examples/ci` são testados como texto e pelo comando; nenhum pipeline do GitHub ou do GitLab os executou de ponta a ponta, e a imagem de ferramentas ainda não foi publicada num registro.

## Adaptadores

- **Ponte (quality-bridge).** A ponte não participa mais dos planos do `jgates run`; ela serve ao `jgates ci`. As capacidades dela estão `declared` (declaradas, sem prova) na matriz.
- **ESLint em monorepo.** O ESLint dos templates roda na raiz do workspace, não na pasta de cada componente.
- **Go, Rust e .NET** têm suporte parcial; a lista do que não é coberto está na matriz de [compatibilidade](compatibility.pt-BR.md).
- **Suas ferramentas próprias** nunca contam como capacidades validadas, e um `timeoutSeconds` por instância é ignorado por alguns adaptadores externos.

## Relacionados

[Segurança](security.pt-BR.md) · [problemas comuns](troubleshooting.pt-BR.md)
