# JGates: a interface local

`jgates ui` abre a interface do JGates só neste computador (`127.0.0.1`; o link de entrada está em [primeiros passos](getting-started.pt-BR.md#a-interface)). Esta página percorre o que aparece ali: a configuração guiada, a escolha do motor de contêineres, as telas de configuração, o editor de YAML, a execução e o resultado. Tudo o que a interface faz tem um comando equivalente, mostrado ao lado.

A interface segue o idioma escolhido em Preferências (Português do Brasil ou English). Telas longas vêm agrupadas e recolhidas com contagens, todo controle desativado diz por que está desativado, todo diálogo começa no primeiro campo, e toda tela também funciona com 375 px de largura e só com o teclado.

## A configuração guiada

Um projeto sem configuração do JGates abre na **Configuração guiada** (a visão geral a mostra até a configuração terminar). Um projeto já configurado a mantém fechada: **Abrir o assistente** (na tela Workspace, com uma lista do passo em que começar) a reabre em `#/setup` com os valores atuais, sem tomar o lugar da visão geral. O indicador de passos no topo mostra os seis passos; um passo ainda travado diz o que o libera.

### 1. Docker

O mascote médico examina a máquina (examinando, preciso de você, tudo certo, não consegui examinar) acima de uma lista, **O que o JGates precisa**, com os valores medidos nesta máquina:

| Requisito | Recomendado | O que acontece abaixo disso |
| --- | --- | --- |
| Motor de contêineres | respondendo | nada roda sem ele: instale ou inicie (os comandos aparecem, nada roda sem você) |
| Memória do motor | 8 GB | só um aviso: as verificações maiores podem falhar ou demorar mais |
| Disco livre | 15 GB | só um aviso |
| CPUs | 2 | só um aviso |

**O executável do motor de contêineres** é uma lista: **Docker**, **Podman** ou **Outro executável…** com o caminho. Cada opção diz se o executável foi encontrado no `PATH`; **Testar** confere que ele responde e **Usar este executável** grava a escolha. Ela fica como `containerRuntime` no `preferences.json` da [pasta de dados](data-folder.pt-BR.md) e vale para a interface e para todos os comandos dali em diante. A variável de ambiente `JGATES_CONTAINER_RUNTIME`, quando definida, continua valendo acima da escolha gravada.

O passo confere de novo a cada 3 segundos enquanto a página está aberta, então um Docker iniciado em outra janela aparece na hora.

### 2. Ferramentas

O passo lista o que vai ser baixado, antes de baixar qualquer coisa:

- a **imagem de ferramentas** (`jgates-tools`): a versão, o tamanho do download e o espaço em disco, e as ferramentas que ela traz, cada uma com versão, licença e para que serve;
- os quatro **bancos de dados de segurança** (Trivy, OSV, banco de vulnerabilidades do Go, RustSec): de onde vem cada um, o tamanho aproximado e quais verificações o usam;
- os totais e o espaço livre no disco.

**Baixar as ferramentas do JGates** inicia o download, com progresso, velocidade e tempo restante; ele continua em segundo plano enquanto você segue. Quando tudo está pronto, o passo diz isso e oferece **Continuar**.

### 3. Projeto

Cada componente encontrado pela descoberta é descrito em palavras: onde fica, a linguagem e o framework, o gerenciador de pacotes, a versão da linguagem e o lockfile, com os arquivos que o mostraram (as evidências). Um componente na raiz do projeto é chamado assim. Só o que é ambíguo pede uma escolha, e os gerenciadores oferecidos seguem a linguagem escolhida. **Declarar componente** abre o mesmo diálogo da tela Workspace, com um seletor das pastas do projeto, sem sair do assistente. Quando o projeto tem arquivos de compose, o passo oferece usar os [serviços](services.pt-BR.md) deles.

### 4. Perfil

Escolha **Essencial**, **Equilibrado** ou **Rigoroso** (e qualquer perfil que você criar), cada cartão com quantas verificações rodam neste projeto. A faixa de mascotes de qualidade acompanha a seleção.

O editor de perfil de Configuração > Perfil está dentro do passo: as categorias se abrem em capacidades e ferramentas, e cada chave muda as contagens na hora. **Criar perfil a partir deste** pede um nome e uma descrição e o acrescenta aos cartões. Até você confirmar, tudo é gravado num rascunho guardado na pasta de dados, nunca no projeto: **Desfazer as mudanças** descarta o rascunho, e **Ver o arquivo antes de salvar** mostra exatamente o que vai ser gravado. **Salvar e continuar** grava `jgates.yml` e `.jgates/profiles.yml` (numa configuração que já existe, só os arquivos que mudaram).

### 5. Dependências

Uma linha por unidade de instalação: o gerenciador, o lockfile, a linguagem, o que é instalado (pelo lockfile ou pelo manifesto, com os comandos), o volume e onde ele é montado, e a rede usada (só o registry de pacotes, só durante a instalação). O estado vem da última instalação; quando todas as unidades estão prontas, não há nada para apertar.

### 6. Revisão

- **Gate e alvo**: quais verificações executar (qualidade, Semântica ou as duas) e sobre o quê (o workspace inteiro, o último commit, as mudanças da branch em relação a uma base, uma comparação entre duas referências, um pull request ou uma pasta), com listas das branches, tags, commits recentes e pastas do projeto. **Usar como padrão do projeto** guarda a escolha para as próximas validações (em `selection` do `jgates.yml`).
- **O plano por categoria**, nomeado pelo que é verificado.
- **O que não vai rodar**: cada verificação que não vai rodar é um item com a verificação e a ferramenta, o motivo e o que fazer, com um botão que funciona quando há uma ação (preparar, baixar, configurar). Uma verificação que não se aplica a este projeto não tem ação.
- **Preparação**: o que ainda está pendente (imagem de ferramentas, dados de segurança, dependências) aparece à parte, um botão para cada um, e o passo diz exatamente pelo que está esperando.

**Executar a primeira validação** a inicia (ou **Executar assim que estiver pronto** enquanto algo está sendo preparado).

## Telas de configuração

A área Configuração tem uma tela por arquivo ou assunto: Perfil, Ferramentas, Execução, Workspace, Dados pessoais, Política, Dependências, Imagem de extensão, Templates, Arquitetura, Serviços e os arquivos YAML.

### Como os formulários funcionam

Os formulários são derivados dos schemas dos arquivos de configuração, então toda chave tem um controle, e eles mostram o que estiver no arquivo, inclusive chaves escritas à mão (uma chave que o JGates não conhece aparece como campo de texto, nunca escondida). O controle segue o valor: uma chave liga/desliga para sim ou não, opções ou uma lista quando os valores são conhecidos, um número com limites e atalhos (mais "Outro valor..."), uma lista de marcar, um editor de lista, ou um seletor (arquivos e pastas do projeto, branches, tags e commits, serviços e portas do compose, nomes do catálogo) com "Outro..." para digitar. Digitar é a alternativa, não a regra.

- Cada valor mostra de onde vem: o arquivo, a configuração, o perfil, um template, o padrão da ferramenta.
- **Voltar ao herdado** tira a chave do arquivo, e o valor herdado volta a valer.
- **Editar no YAML** abre o editor de YAML no arquivo, naquela chave.
- Cada salvamento grava uma chave e nada mais: comentários, ordem e as outras chaves do arquivo ficam idênticos, byte a byte. Antes de gravar, um diálogo mostra a diferença no arquivo; uma chave liga/desliga salva na hora. Depois de salvar, **Desfazer** volta o arquivo ao que era.
- Um arquivo com uma chave inválida abre mesmo assim: a tela lista o problema com arquivo, chave e linha e um link para o editor de YAML, em vez de ficar em branco.
- Se o arquivo mudou no disco depois que a tela o leu, nada é gravado: a tela avisa e oferece **Recarregar o formulário**.

### Perfil

Os perfis do projeto, as categorias do selecionado e, para cada perfil, o editor do `.jgates/profiles.yml` (**Editar** leva direto a ele). **Criar perfil** pede o nome (o id sai dele) e uma descrição; perfis podem ser duplicados, renomeados, virar o padrão e ser apagados (o perfil padrão não pode ser apagado, e o botão diz por quê). Toda ação mostra que está em andamento e a tela mantém o conteúdo enquanto atualiza. Uma seção edita os seletores de dados pessoais, arquitetura e componentes do perfil, e a categoria **Verificações próprias** lista as suas ferramentas e oferece **Adicionar ferramenta própria**.

### Ferramentas

**Ferramentas em uso neste projeto** lista o que o plano executa, por categoria, com um link para a página de cada ferramenta; as suas instâncias aparecem à parte. O catálogo mostra primeiro as ferramentas deste projeto (pelas linguagens dele), pode mostrar todas, e uma busca ordena pelo nome. Cada cartão diz uma vez de onde a ferramenta vem: incluída na imagem de ferramentas (com versão e licença), sua, ou fornecida pelo projeto. **Adicionar ferramenta** já vem com a linguagem do projeto selecionada e segue para as configurações da nova instância.

Toda página de ferramenta mostra o formulário de configurações dela, também para uma ferramenta que um template traz, além da memória, das CPUs e do limite de tempo que valem, com a origem de cada um. Uma ferramenta própria pode ser editada nos mesmos seis passos que a criaram e testada com **Testar agora** (veja [suas próprias ferramentas](extension.pt-BR.md)).

### Execução, Workspace, Dados pessoais, Política, Dependências, Imagem de extensão

- **Execução**: toda chave de `execution:` no `jgates.yml` (limites, idade dos dados, parar na primeira falha, imagem de extensão, confiança em resultados autodeclarados) como controles; as mudanças ficam num rascunho até **Revisar e salvar** mostrar a diferença e gravá-las juntas.
- **Workspace**: os componentes; **Mais campos** em cada componente declarado edita a entrada inteira (tipo, ativo, incluir e excluir, dependências, grupos), a chave da descoberta fica na aba de escopo, e o caminho de um componente declarado vem de um seletor de pastas.
- **Dados pessoais** (`#/tools/builtin-pii`): a tabela de entidades mais o formulário do `.jgates/pii.yml` (severidade, ferramentas, correção, modo do hook).
- **Política** (`#/policy`): o formulário do `.jgates/policy.yml`, criado quando falta; só leitura, com o motivo, quando uma política de CI governa o projeto.
- **Dependências** (`#/config/dependencies`): os gerenciadores de pacotes que o JGates encontrou e o formulário do `.jgates/dependencies.yml` (registries privados dão o nome do segredo, nunca o token).
- **Imagem de extensão** (`#/config/image`): o Dockerfile da sua imagem de extensão, se ela está pronta ou desatualizada (com a causa) e **Reconstruir**.

### Templates, Arquitetura e Serviços

- **Templates**: **Criar template** é um passo a passo: o que ele verifica (a capacidade, escolhida pelo nome), onde se aplica (linguagens e frameworks, um de cada vez), o comando (um executável mais uma lista de argumentos) e uma revisão com a diferença de cada arquivo. Templates do projeto podem ser editados e apagados; um arquivo de template que o `jgates.yml` não usa aparece como **Fora do jgates.yml**, com **Usar neste projeto**.
- **Arquitetura**: **Criar regras de arquitetura** ou **Editar camadas e regras** abre um passo a passo que propõe camadas a partir das pastas do projeto e regras a partir das camadas, depois mostra a diferença; salvar muda só o que mudou, então comentários e regras escritas à mão ficam.
- **Serviços**: os arquivos de compose, os papéis dos serviços, o alvo e a revisão são passos do mesmo passo a passo (veja [serviços](services.pt-BR.md)).

## O editor de YAML

**Arquivos YAML** (`#/config/yaml`) edita o texto do `jgates.yml` e dos arquivos de `.jgates`. Um link de qualquer tela (**Editar no YAML**) abre o arquivo com o cursor na chave; uma chave que ainda não está no arquivo põe o cursor na seção mais próxima.

- A estrutura é conferida enquanto você digita: sintaxe, schema e referências, com marcas no editor e uma lista de problemas, cada um com o arquivo, a chave e a linha (**Ir para a linha**). As mensagens são em palavras simples (um padrão permitido, um limite, as formas que um valor pode ter).
- **Salvar** fica desativado enquanto há problemas; **Salvar mesmo assim** grava o texto sabendo que o plano não vai ser aprovável até a correção.
- Um arquivo de configuração que ainda não existe (arquitetura, dados pessoais, dependências, política) aparece como **Não criado**, com **Criar**: ele começa de um modelo válido.
- Se o arquivo mudou no disco depois que você o abriu, salvar é recusado até você olhar a versão atual: nada é sobrescrito.

## Executar e ler o resultado

A tela da execução mostra as cinco fases (sincronização, dependências, serviços, verificações, desligar os serviços), cada uma com o log fechado até você abrir, e as verificações uma vez, conforme terminam. Quando a execução termina, o estado dela diz a decisão (uma execução reprovada nunca aparece só como "concluída") e **Abrir o resultado** leva a ele. O resultado também se abre pelo Histórico (`#/validations`) e pela visão geral, cujo próximo passo depois de uma execução é o resultado.

A tela do resultado:

- um cartão por verificação, com ícone e palavra próprios para cada estado: passou, falhou, incompleta, bloqueada, não se aplica, desligada; com a ferramenta, a duração e o número de achados;
- um cartão por achado: severidade, ferramenta, regra, mensagem, a correção quando a ferramenta dá uma, e o `arquivo:linha`;
- **Dispensar** em cada achado que pode ser dispensado: pede um motivo e uma data final, mostra antes a entrada exata e só então a grava no `.jgates/waivers.json` do projeto. Uma dispensa aponta para uma ocorrência do achado;
- as dispensas do projeto, listadas na revisão do plano: cada uma com o motivo, a data final e o estado (vigente, vencida ou desatualizada), e um jeito de removê-la. Uma dispensa vencida, ou que não casa mais com o código de forma segura (desatualizada), não vale;
- uma execução que passa com dispensas diz "aprovado com N dispensas" e lista os achados que elas cobrem;
- filtros por severidade, ferramenta, categoria e componente;
- **Exportar JSON**, **Exportar SARIF** e **Copiar para o agente** (um resumo seguro para colar num agente; nada é enviado);
- com o que a execução rodou (versão do JGates, imagem de ferramentas, idade dos dados de segurança, chaves das dependências, serviços).

Uma verificação que não pode rodar diz por quê e o que fazer (veja os [códigos de motivo](troubleshooting.pt-BR.md#códigos-de-motivo)). O teste de mutação, por exemplo, não se aplica enquanto os testes do próprio projeto falham, e roda quando eles passam.

## Mascotes

O médico acompanha o estado da máquina (passo 1 do assistente, a tela Ambiente e a visão geral), a faixa de mascotes de qualidade acompanha as categorias de um perfil (passo 4 do assistente, Perfil, Templates, o catálogo de ferramentas), e a revisão Semântica tem seis mascotes 3D estáticos, um por fase (veja [mascotes do Semantic](semantic-mascots.pt-BR.md)).
