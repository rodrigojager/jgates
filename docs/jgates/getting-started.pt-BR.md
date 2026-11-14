# JGates: primeiros passos

O JGates valida um repositório antes de uma aprovação: descobre os componentes, monta um plano que você pode revisar, executa as verificações e grava um resultado com a decisão e as evidências. O JGates reúne o quality gate (`quality-gate`) e o semantic gate (`semantic-gate`); o comando principal é o `jgates`.

Toda verificação roda dentro de um contêiner de uma imagem de ferramentas completa do JGates. O seu projeto é copiado para um volume do Docker e nunca é modificado; as dependências dele são instaladas em volumes próprios. Por isso a única coisa que você instala na sua máquina é o JGates e um motor de contêineres.

Esta página vai do zero até a primeira validação. As outras páginas desta pasta: [a interface local](local-ui.pt-BR.md), [templates e perfis](templates-and-profiles.pt-BR.md), [editor](editor.pt-BR.md), [adaptadores](adapters.pt-BR.md) (com a [matriz de compatibilidade](compatibility.pt-BR.md)), [serviços](services.pt-BR.md), [suas próprias ferramentas](extension.pt-BR.md), [armazenamento e limpeza](storage.pt-BR.md) e [problemas comuns](troubleshooting.pt-BR.md).

## O que você precisa

- Node 22 ou mais novo e Git, para rodar o próprio JGates.
- Um motor de contêineres compatível com o Docker, rodando num sistema `linux/amd64`. Docker Desktop, Rancher Desktop, Podman Desktop ou o Docker Engine no Linux funcionam. O Docker Desktop tem termos de licença próprios, que dependem de quem o usa e de como; leia-os no site da Docker, ou escolha uma das alternativas. Para usar outro executável que não seja `docker`, escolha-o no passo Docker da configuração guiada (Docker, Podman ou outro executável; fica gravado nas preferências) ou defina `JGATES_CONTAINER_RUNTIME`, que vale acima da escolha gravada.
- Memória para o motor: 4 GB ou mais é o recomendado (um passo pede 4 GB e 2 CPUs por padrão), e espaço em disco para a imagem de ferramentas: cerca de 2 GB para baixar e uns 6 GB descompactada.
- Mais nada. Nenhum scanner, linter, executor de testes ou runtime de linguagem do projeto é instalado na sua máquina: tudo vem na imagem de ferramentas.

No Windows, o Docker Desktop precisa do WSL 2; veja [problemas comuns](troubleshooting.pt-BR.md#windows-e-wsl). O Linux é o sistema testado; o fluxo do primeiro uso também foi conferido à mão no Windows 10 (veja [limitações](limitations.pt-BR.md)), e o macOS não foi testado num Mac real.

## Instalar o JGates

O JGates não é publicado no registro do npm: a instalação vem do repositório no GitHub. Numa pasta vazia (ou na pasta do seu projeto):

```bash
npm install git+https://github.com/rodrigojager/jgates
npx jgates --version
```

O npm baixa o repositório e roda o script `prepare`, que compila o JGates e a interface; isso leva alguns minutos. Daí em diante os comandos são `npx jgates`, `npx quality-gate` e `npx semantic-gate` (ou `node_modules/.bin/...`). Os exemplos abaixo escrevem `jgates` direto, como se ele estivesse no `PATH`.

Para ter o `jgates` no `PATH` sem depender de um projeto, instale numa pasta própria e coloque a pasta de executáveis dela no `PATH` (no Windows, adicione o `node_modules\.bin` dessa pasta ao `Path`):

```bash
npm install --prefix "$HOME/jgates-tool" git+https://github.com/rodrigojager/jgates
export PATH="$HOME/jgates-tool/node_modules/.bin:$PATH"
jgates help
```

Para uma instalação global, ou para instalar numa máquina sem acesso ao GitHub, empacote um clone e instale o arquivo gerado. Este é o caminho coberto pelo teste `tests/install.test.js` e pelo script `scripts/smoke-install.mjs`, inclusive numa pasta com espaço e acentos no caminho:

```bash
git clone https://github.com/rodrigojager/jgates.git
cd jgates
npm install
npm pack
npm install --global ./jgates-0.3.0.tgz
jgates help
```

No Windows, o `npm install --global` coloca `jgates`, `quality-gate` e `semantic-gate` em `%APPDATA%\npm`, uma pasta que o instalador do Node.js já adiciona ao `Path`: abra um terminal novo e o `jgates --version` responde de qualquer pasta. Para atualizar, rode `jgates update`; num clone, rode `npm pack` de novo e repita o `npm install --global` com o arquivo novo. Depois de uma atualização, o `jgates setup` baixa as ferramentas da versão nova.

O `npm install --global git+https://github.com/rodrigojager/jgates` **não funciona**: numa instalação global de uma dependência git, o npm liga os comandos a um clone temporário que depois apaga. Use a pasta com `--prefix`, a instalação dentro do projeto ou o tarball (veja [limitações](limitations.pt-BR.md)).

## Preparar a máquina

```bash
jgates setup
jgates status
```

O `setup` prepara esta máquina em cinco passos e imprime cada um: **Engine** (acha o motor de contêineres e confere que ele responde), **Disk** (confere que há espaço para o download mais uma margem), **Image** (baixa a imagem de ferramentas na versão que este JGates fixa, com progresso), **Volumes** (cria os volumes compartilhados) e **Data** (baixa as bases de vulnerabilidades). Pode rodar de novo sem problema: uma máquina pronta termina em segundos. Sai com 0 quando a máquina está pronta e com 2 quando não está, e cada motivo tem um código e uma ação (veja a [lista de motivos](troubleshooting.pt-BR.md#códigos-de-motivo)).

- `--yes` inicia um motor parado quando o comando de início dele não pede senha de administrador, e espera por ele.
- `--no-data` pula as bases de vulnerabilidades; as verificações que precisam delas ficam `incomplete` até você baixá-las (veja abaixo).
- `--from <arquivo>` carrega a imagem de um arquivo gerado por `jgates tools export` em vez de baixá-la (veja [máquinas offline](#máquinas-offline)).

O `status` responde "esta máquina consegue rodar verificações?" numa tela: o motor (versão, memória, CPUs), a imagem de ferramentas e a versão dela, as imagens de extensão, a idade de cada base de vulnerabilidades em relação ao limite, as dependências e os serviços do workspace atual e o disco que o JGates usa. Não muda nada.

O `doctor` mantém o fluxo próprio: diagnostica as mesmas coisas, classifica o que falta como essencial, opcional ou não usado para o plano do projeto atual, oferece preparar (num terminal, ou com `--fix`) e imprime o bloco do status no fim. Nunca instala uma ferramenta na sua máquina; o que ele pode oferecer é instalar ou iniciar o motor de contêineres (o comando oficial do sistema, mostrado antes de rodar e nunca executado em silêncio), baixar a imagem de ferramentas e preparar os dados.

```bash
jgates doctor
```

Uma receita que instala o Docker é mostrada com o comando do sistema (`apt-get` no Debian e no Ubuntu, `dnf` no Fedora, `brew` no macOS, `winget` no Windows) e só roda depois de um "s" no terminal; o próprio comando pede `sudo`, e o `--yes` não o cobre. Os comandos do macOS e do Windows ainda não foram testados nessas máquinas.

## A configuração guiada do primeiro uso

Na interface (`jgates ui`), um projeto que ainda não terminou de ser configurado abre a **Configuração guiada** (`#/setup`) sozinha. Ela tem seis passos e cada um mostra o comando equivalente:

1. **Docker**: o mascote médico examina a máquina e mostra o que o JGates precisa com os valores medidos (motor, memória, disco livre, CPUs; abaixo do recomendado é só um aviso), e a escolha do executável do motor (Docker, Podman ou outro executável, testado e gravado nas preferências). Quando o motor falta ou está parado, mostra os comandos para instalar ou iniciar (nada roda sem você). Confere de novo a cada 3 segundos enquanto a página está aberta.
2. **Ferramentas**: lista o que vai ser baixado (a imagem de ferramentas com versão, tamanho e as ferramentas que traz, e os quatro bancos de dados de segurança) e baixa, com progresso, velocidade e tempo restante. O download continua em segundo plano, então você pode seguir para os próximos passos; se o servidor reiniciar, baixe de novo e o que já chegou é reaproveitado.
3. **Projeto**: descreve em palavras cada componente que a descoberta achou (linguagem, framework, gerenciador de pacotes, versão da linguagem, lockfile, com as evidências) e pergunta só sobre o que é ambíguo; **Declarar componente** funciona dentro do assistente. Também oferece os [serviços](services.pt-BR.md) do compose do projeto.
4. **Perfil**: Essencial, Equilibrado ou Rigoroso, com o editor de perfil dentro do passo: ligue e desligue capacidades e ferramentas e crie um perfil novo sem sair do assistente, num rascunho que só vira arquivo quando você confirma. O Rigoroso liga tudo o que tem ferramenta para este projeto; o que não se aplica aparece com o motivo e nunca bloqueia.
5. **Dependências**: mostra, por unidade, o gerenciador, o lockfile, o que é instalado, o volume e a rede, e prepara as dependências em volumes (a primeira vez leva alguns minutos).
6. **Revisão**: o gate e o alvo, o plano por categoria, cada verificação que não vai rodar com o motivo e a ação, e o que ainda falta preparar; inicia a primeira validação, agora ou assim que a preparação terminar.

**Abrir o assistente** (na tela Workspace) abre o assistente de novo com os seus valores atuais. Tudo o que o assistente faz tem um comando: `jgates setup`, `jgates init`, `jgates deps prepare` e `jgates run`. Cada passo, as telas de configuração, o editor de YAML e o resultado estão descritos em [a interface local](local-ui.pt-BR.md).

## Descobrir e configurar

```bash
jgates discover
jgates init --profile standard --no-interactive
jgates config validate
```

- `discover` lê só os arquivos do projeto (nada é executado) e lista os componentes e as linguagens: no repositório de exemplo, `api` (Python), `web` e `libs/shared` (TypeScript).
- `init` cria o `jgates.yml` e o `.jgates/profiles.yml` com o perfil que você escolher (`minimal`, `standard` ou `strict`; o padrão é `standard`) e os templates das stacks que achou. Se já existe configuração, recusa com `CONFIG_EXISTS` e não muda nada.
- `config validate` confere a sintaxe, o schema e as referências dos arquivos e aponta o arquivo e a linha de cada problema.

Os arquivos do projeto são versionados com o código (`jgates.yml`, `.jgates/*.yml`, `.jgates/lock.json`). O que o JGates produz (execuções, rascunhos, planos) vai para a [pasta de dados](data-folder.pt-BR.md), fora do projeto, e as partes pesadas ficam no motor de contêineres.

## Preparar o que as verificações precisam

### As dependências do projeto

Testes, verificações de tipos e builds precisam das dependências do próprio projeto. Os pacotes do seu `.venv` ou `node_modules` são feitos para o seu sistema e não rodam num contêiner Linux, então o JGates as instala por conta própria, a partir dos seus manifestos e lockfiles, num volume por componente (`jgates-<workspace>-deps-<componente>`). Nada é escrito no projeto, e os scripts de instalação dos pacotes rodam dentro do contêiner.

```bash
jgates deps status
jgates deps prepare
jgates deps clean
```

- `deps status` mostra, por componente, se as dependências estão prontas, desatualizadas, ausentes ou com falha, e o gerenciador que o JGates detectou (pip, uv, poetry, pdm, pipenv, npm, yarn, pnpm, go, cargo, dotnet). `--component <id>` limita a um.
- `deps prepare` as instala. Uma execução também prepara o que precisa; este comando serve para fazer isso antes. O volume tem uma chave feita do lockfile, do manifesto, do gerenciador, da versão da linguagem e da versão da imagem: quando a chave não muda nada é reinstalado, e uma instalação que falha nunca substitui um volume bom.
- `deps clean` apaga os volumes de dependências do workspace.
- Um componente sem lockfile instala a partir do manifesto e mostra uma nota ("as versões podem variar"); no `jgates ci` isso é um bloqueio.
- Quando um componente fixa uma versão de linguagem diferente da padrão da imagem (`.python-version`, `.nvmrc`, `go.mod`, `rust-toolchain.toml`, `global.json`), o JGates a instala no volume compartilhado `jgates-toolchains`. Se não for possível obtê-la, as verificações desse componente ficam não prontas, com o motivo e uma ação. Para usar a versão padrão da imagem desta vez, defina `JGATES_TOOLCHAIN_DEFAULT` como `1` (todas as linguagens) ou como uma lista, como `python,node`.
- Para um registro privado, declare-o em `.jgates/dependencies.yml`: a URL e o **nome** do segredo que guarda o token, nunca o token. O valor vem do seu [cofre de chaves](security.pt-BR.md#o-cofre-de-chaves-do-usuário) ou do ambiente do CI, chega ao contêiner de instalação só na memória e em `/tmp`, e é mascarado nos logs.

```yaml
# .jgates/dependencies.yml
schemaVersion: 1
registries:
  node:
    url: https://registry.example.org/npm/
    tokenSecret: NPM_TOKEN
```

### Dados de segurança

Os scanners de vulnerabilidades rodam sem rede, então as bases ficam no volume `jgates-data` e são atualizadas à parte da execução:

```bash
jgates tools update-data
```

Ele atualiza as bases do Trivy, do OSV, do Go e do RustSec e registra quando cada uma foi buscada; o resultado também registra. Uma base mais velha que o limite (7 dias por padrão, `execution.dataMaxAgeDays` no `jgates.yml`) deixa as verificações que a usam `incomplete` com `DATA_STALE`, e uma nunca baixada com `DATA_MISSING`: uma varredura com dados velhos ou sem dados nunca é dada como limpa. A política de uma execução governada pode exigir um limite menor. O `jgates setup` já as baixa, e o `jgates status` mostra a idade de cada uma. O espelho do OSV cobre só npm, PyPI, Go, crates.io e NuGet.

### CodeQL

O CodeQL não está na imagem de ferramentas: os termos dele não permitem redistribuí-lo. Se você quer a capacidade `dataflow`, você mesmo o prepara:

```bash
jgates tools prepare-codeql --accept-terms
```

O comando pede que você aceite os termos do CodeQL do GitHub, registra o aceite com a data na pasta do JGates (nunca no projeto), baixa o bundle da versão oficial, confere o SHA-256 e o descompacta no volume `jgates-codeql`, que uma verificação monta somente leitura e sem rede. Preparar ou não é escolha sua; até você fazer isso, a capacidade fica `incomplete` com `CUSTOMER_SUPPLIED`.

### Máquinas offline

Numa máquina que não alcança o registro, exporte a imagem onde há acesso e importe onde não há:

```bash
jgates tools export jgates-tools.tar
jgates tools import jgates-tools.tar
```

O `export` grava a imagem como um tarball junto com o registro dela, e o `import` a confere pelo digest antes de carregá-la. O `jgates setup --from jgates-tools.tar` carrega e prepara num passo só.

## Ver o plano e executar

```bash
jgates plan
jgates run
```

O `plan` não instala, não executa e não altera nada. Mostra três grupos: o que vai rodar (com o comando efetivo e de onde veio cada decisão), o que fica de fora e os requisitos sem cobertura. Um requisito obrigatório que nenhuma verificação cobre torna o plano não aprovável. Uma verificação que não se aplica ao projeto aparece como "não se aplica aqui", com o motivo e o que fazer, e nunca bloqueia.

O `run` executa exatamente um plano. Para executar exatamente o plano que você revisou:

```bash
jgates plan --out ./plano.json
jgates run --plan ./plano.json --no-interactive
```

Se o projeto ou o plano mudou depois de salvo, o `run --plan` recusa (`PLAN_STALE` ou `PLAN_TAMPERED`, saída 3) em vez de executar outra coisa.

### Códigos de saída

| Código | Decisão | Significado |
| --- | --- | --- |
| 0 | `passed` | Todo requisito obrigatório foi coberto e passou. |
| 1 | `failed` | Algum requisito falhou. |
| 2 | `incomplete` | Algo obrigatório não pôde ser provado (ferramenta ausente, cobertura parcial, dados ausentes, serviços que não subiram, execução reduzida). Nunca vira aprovado. |
| 3 | `invalid` | Uso ou configuração inválidos; nada foi executado. |
| 4 | erro interno | Uma falha do próprio JGates. |
| 130 | `cancelled` | A execução foi interrompida. |

## Resultado e histórico

```bash
jgates history
jgates report <runId> --format json
jgates report <runId> --format sarif --out ./relatorio.sarif
```

Cada execução grava um `result.json` na pasta de dados. O `report --format json` devolve esse arquivo sem mudar um byte, e o `--format sarif` produz um SARIF 2.1.0 para ferramentas de revisão de código. O `report <runId> --agent-context` produz o resumo seguro para colar num agente; o mesmo resumo é gravado em `agent-context.md` na pasta da execução, e a saída do `jgates run` termina com o caminho dele ("Para corrigir... leia"). Num terminal, o `run` mostra cores e uma linha ao vivo com o tempo do passo em andamento; `--plain` dá a saída enxuta para agentes e logs.

## A interface

```bash
jgates ui --no-open
```

O `ui` inicia um servidor local só neste computador (`127.0.0.1`). Ele não imprime o segredo da sessão: o link de entrada, de uso único e válido por 10 minutos, está num arquivo da pasta de dados (o campo `launcher` da saída `--json`). Abra esse arquivo no navegador. Sem `--no-open`, o JGates abre o navegador sozinho.

Telas principais: Visão geral (`#/overview`), Workspace (`#/workspace`), Ferramentas (`#/tools`), Configuração (`#/config`), com Serviços (`#/config/services`), Ambiente (`#/environment`), Semantic (IA) (a configuração da revisão em `#/semantic/setup` e a tela Providers e chaves em `#/semantic/providers`), Preferências (`#/preferences`), com Armazenamento (`#/preferences/storage`), e Ajuda (`#/help`). Tudo o que a interface faz tem um comando equivalente. Os formulários de configuração, o editor de YAML e a leitura do resultado estão em [a interface local](local-ui.pt-BR.md).

O botão do workspace no topo da barra lateral troca para outro projeto: escolha um dos workspaces conhecidos, digite o caminho de uma pasta ou use **Procurar...** para percorrer as pastas desta máquina (os drives no Windows) e abrir uma. Uma pasta que já tem configuração do JGates ou do Git aparece marcada na lista. Um projeto sem configuração abre na configuração guiada.

**Declarar um componente.** Na tela Workspace, o botão **Declarar** (diálogo "Declarar componente") sugere as pastas do projeto (os componentes detectados aparecem marcados como "componente detectado"). **Linguagem** é uma lista em dois grupos, "Com verificações do JGates" e "Reconhecidas, sem ferramentas ainda" (C++, por exemplo: o componente aparece no inventário e nenhuma verificação roda nele, e o diálogo oferece adicionar uma [ferramenta própria](extension.pt-BR.md) para ele), mais "Detectar pela pasta" e "Outra...". **Framework** lista só os frameworks da linguagem escolhida. Os valores gravados em `.jgates/workspace.yml` são ids em minúsculas.

**Ler o log de um passo.** Na tela da execução, os logs de um passo aparecem como um bloco por ferramenta, com a "Saída padrão" e a "Saída de erro" dentro. O que o próprio JGates registrou (programa, argumentos, pasta, código de saída, duração) fica numa linha recolhida "Comando executado", fora da saída. Muitas ferramentas escrevem progresso e avisos na saída de erro, e isso é normal: se um passo falhou quem diz é o estado dele na tabela, não o texto do log. O bloco de um passo que falhou vem destacado e aberto primeiro.

## No CI e com agentes

Os comandos aceitam `--json` (um único documento no stdout; o progresso para humanos vai para o stderr) e `--no-interactive` (nunca espera uma resposta: um dado que falta vira um erro com a instrução de correção). O ciclo de um agente é planejar, executar, corrigir e executar de novo, sem mudar os critérios; o skill `jgates/skill/SKILL.md` descreve o ciclo. Num pipeline de CI que impõe as regras, o comando é `jgates ci`, descrito em [CI](ci.pt-BR.md).

```bash
jgates run --profile standard --scope changed --base main --no-interactive --json
```

Uma execução com `reduced: true` (algo que o perfil exige foi desligado só naquela execução) nunca fecha o ciclo como aprovada. Veja [templates e perfis](templates-and-profiles.pt-BR.md).
