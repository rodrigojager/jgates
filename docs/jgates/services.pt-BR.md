# JGates: serviços do projeto

Algumas verificações precisam de algo em execução: um banco de dados para os testes de integração, a própria aplicação para os testes ponta a ponta (Playwright), o contrato da API (Schemathesis), a varredura dinâmica de segurança (ZAP) e as verificações de migração. O JGates sobe esses **serviços** a partir dos seus próprios arquivos do Docker Compose, só durante a validação, numa rede isolada, e desliga tudo no fim. Os arquivos de compose servem para serviços: nunca instalam uma ferramenta (as ferramentas vêm da [imagem de ferramentas](getting-started.pt-BR.md) ou da [sua própria imagem](extension.pt-BR.md)).

Os serviços são opcionais. Um projeto sem arquivo de compose ainda recebe todas as verificações que não precisam de serviço em execução; uma verificação que precisa de um aparece como "não se aplica aqui", com o motivo e a ação "Configurar serviços", e nunca bloqueia.

## O que o JGates detecta

A descoberta lê os arquivos de compose (`compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` e as sobreposições `compose.*.yaml`) como YAML comum, sem executar nada: nomes dos serviços, imagem ou build, portas, healthchecks e profiles. Ela sugere um papel a partir da evidência: uma imagem `postgres`, `mysql`, `mongo` ou `redis` é uma dependência, e um serviço construído a partir do Dockerfile do próprio projeto que publica uma porta HTTP é a aplicação sob teste.

Ela também aponta as configurações que alcançam a sua máquina, para que a revisão as mostre antes de qualquer coisa subir:

- um bind mount de uma pasta do computador;
- `privileged: true`;
- `network_mode: host`;
- `pid: host`;
- um mapeamento de dispositivo;
- `cap_add`.

## Configurar

Na interface, abra **Configuração > Serviços** (`#/config/services`). A tela lista os arquivos de compose (a ordem é a ordem de uso), os serviços encontrados com os papéis sugeridos, a aplicação sob teste (serviço, porta, caminho base e caminho de saúde), os efeitos de cada serviço na sua máquina e um botão **Testar subida** que sobe os serviços, espera por eles, mostra os logs e desliga tudo. **Pré-visualizar mudanças** mostra o que vai mudar no `jgates.yml` antes de salvar. O assistente oferece a mesma escolha no passo Projeto.

À mão, a seção é opcional e fica no `jgates.yml`:

```yaml
services:
  compose: [compose.yaml, compose.test.yaml]   # arquivos, em ordem
  profiles: [test]                              # profiles do compose a ativar
  start: [db, api]                              # serviços a subir; padrão: os que as verificações precisam
  target:                                       # a aplicação sob teste
    service: api
    port: 8000
    path: /
    health: /health
  build: forbid                                 # allow | forbid (padrão forbid)
  writableBinds: []                             # serviços autorizados a escrever na pasta do projeto
  allowHostEffects: []                          # efeitos que uma execução governada aceita
  timeoutSeconds: 120                           # espera pelos healthchecks e pelo caminho de saúde
```

Uma verificação de execução pode nomear o alvo como `service:<nome>:<porta>` (com um caminho opcional) em vez de uma URL: `service:api:8000` ou `service:api:8000/v1`. A configuração `target` das instâncias do ZAP, do Schemathesis e do Playwright aceita esse formato, e o JGates o resolve na rede própria da execução (`http://api:8000`). Um alvo digitado errado é apontado, nunca tomado por uma URL.

## O que acontece numa execução

1. Antes do primeiro passo que precisa de serviços, o JGates sobe os serviços escolhidos com `docker compose` num projeto próprio (`jgates-<workspace>-<execução>`), com os rótulos dele adicionados por um arquivo de sobreposição que fica na pasta da execução, nunca no seu projeto.
2. O Compose só constrói uma imagem com `build: allow`; a revisão então diz quantas imagens serão construídas a partir dos seus Dockerfiles (isso executa o Dockerfile do projeto).
3. Os passos que precisam de serviços entram na rede interna da execução e os alcançam pelo nome. As portas não são publicadas na sua máquina, então uma execução nunca colide com a pilha que você está usando.
4. O JGates espera pelos healthchecks do compose e pelo caminho `health` do alvo. Se não responderem dentro do limite de tempo, os passos dependentes ficam `incomplete` com o motivo `SERVICES_NOT_READY` e os logs dos serviços vão anexados.
5. No fim, sempre (também em cancelamento e falha), tudo da execução é removido, inclusive os volumes que pertencem ao projeto da execução.

## Efeitos na sua máquina

- **A revisão lista todos os efeitos** antes da primeira execução com serviços. No modo local o JGates pede a sua confirmação uma vez, e de novo só quando a seleção do compose muda.
- **O projeto continua intocado.** Um bind mount de uma pasta dentro do projeto (o comum `.:/app` dos arquivos de desenvolvimento) é redefinido como somente leitura no arquivo de sobreposição. Um serviço que falha porque precisa escrever ali é apontado com esse motivo; você pode autorizar com `writableBinds: [api]`, o que fica registrado no `jgates.yml` e aparece em toda revisão seguinte.
- **O Compose lê o `.env`** da pasta do projeto como de costume (a única leitura do computador que o compose faz); o JGates não o copia para lugar nenhum.
- **Os serviços rodam no seu motor como qualquer pilha de compose:** o JGates não acrescenta privilégio.
- **O modo governado** (`jgates ci`) é mais rígido: recusa um bind mount do computador, um serviço privilegiado e os demais efeitos, a menos que a política os liste em `services.allowHostEffects` (os valores são `bind-mount`, `privileged`, `network-host`, `pid-host`, `device` e `cap-add`), e nunca aceita `writableBinds`. Veja [CI](ci.pt-BR.md).

## Problemas

- `SERVICES_REQUIRED`: uma verificação escolhida precisa de um serviço e nenhum está configurado. Abra a tela Serviços e escolha os arquivos de compose e a aplicação sob teste.
- `SERVICES_NOT_READY`: os serviços não ficaram saudáveis a tempo. Leia os logs anexados; aumente `timeoutSeconds` se a aplicação apenas demora a subir.

Os dois aparecem, com os demais, na [lista de motivos](troubleshooting.pt-BR.md#códigos-de-motivo).
