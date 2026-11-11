# JGates: integrações do Quality e a matriz de capacidades

As integrações do Quality estão no catálogo padrão (interface e CLI) por padrão. Se uma delas roda depende da
detecção da stack, do perfil, do rigor, do escopo, dos pré-requisitos e das suas escolhas em cada execução. O Quality
nunca chama um modelo. Toda ferramenta roda na imagem de ferramentas do JGates, que tem todas elas exceto o CodeQL: nada
é instalado na sua máquina e nada é instalado durante uma execução. O `jgates setup` baixa a imagem, e a única integração
que você mesmo prepara é o CodeQL.

## A matriz de capacidade por stack

O suporte é declarado por capacidade e por stack, e só com evidência: uma fixture com defeito conhecido que a verificação
deve apontar, uma fixture limpa que ela deve aprovar e um teste citado pela matriz. Um parser de mentira ou o código de
saída de uma ferramenta, sozinhos, não são eficácia.

```bash
jgates tools matrix
jgates tools matrix --units
jgates tools distribution
```

Cada linha tem um estado: `validated` (há evidência), `customer-setup-required` (a verificação existe, mas você fornece a
preparação, então a suíte padrão não a prova), `unsupported` ou `not-applicable`. A linha também lista os
pré-requisitos, as versões da ferramenta e as limitações. `--units` acrescenta a visão por unidade.
O `jgates tools distribution` verifica se o registro de licença de cada adaptador (distribuído, preparado de fonte
autorizada ou fornecido pelo cliente) está completo e se cada pacote distribuído cumpre os termos da sua licença; é um
registro legal, e o lugar onde a ferramenta roda é sempre a imagem de ferramentas.

## As integrações

| Integração | Capacidade | De onde vem | Stacks e observações |
| --- | --- | --- | --- |
| Semgrep com o pacote de regras do JGates | `sast` | O Semgrep está na imagem de ferramentas; o pacote é distribuído | `tools.<id>.rulePack: jgates` seleciona o pacote (`jgates/packs/semgrep/jgates-semgrep`, regras originais do JGates, MIT). Validado para Python, JavaScript e TypeScript. As regras oficiais do registro do Semgrep nunca são distribuídas e não estão na imagem. |
| zizmor | `ci-cd` | Na imagem de ferramentas | Audita workflows do GitHub Actions. |
| oasdiff | `api-compatibility` | Na imagem de ferramentas | Precisa de um arquivo OpenAPI 3 e de uma referência git ou arquivo como base. Sem extração de contrato a partir do código. |
| Verificação de build | `typecheck` | Na imagem de ferramentas; vale a versão do próprio projeto | Validado para TypeScript, Python, Go, Rust e C#; JavaScript, F# e Visual Basic não são suportados. O template `typescript-tsc` ativa em qualquer `tsconfig.json`. |
| CodeQL | `dataflow` | Você o prepara | Não está na imagem. O `jgates tools prepare-codeql --accept-terms` registra o seu aceite dos termos do GitHub, baixa o bundle oficial e o guarda no volume `jgates-codeql`; até lá a verificação fica `incomplete` com `CUSTOMER_SUPPLIED`. O adaptador é exercitado com um substituto que reproduz um SARIF no formato do CodeQL; um CodeQL real não roda na suíte padrão. |
| Schemathesis | `api-contract` | Na imagem de ferramentas | Precisa de um arquivo OpenAPI 3 e de um alvo HTTP em execução (um [serviço](services.pt-BR.md): `service:<nome>:<porta>`). |
| ZAP | `dast` | Na imagem de ferramentas | Modos passivo e ativo contra um alvo HTTP em execução; o modo ativo ataca o alvo, então use só em sistemas seus. |
| Teste de mutação | `mutation` | As dependências do projeto, ou a imagem de ferramentas | Validado para JavaScript e Python; TypeScript depende da sua preparação. |
| Cadeia de suprimentos | `supply-chain` | Distribuído | Lê lockfiles (npm e Python); aponta scripts de instalação, hashes de integridade ausentes e fontes sem versão fixa ou não confiáveis. |
| Trivy em modo imagem | `dependencies` e `images` | Na imagem de ferramentas | Examina uma imagem de contêiner, não só o sistema de arquivos. |
| govulncheck | `dependencies` | Na imagem de ferramentas | Módulos Go; a base é a que o `jgates tools update-data` mantém. |
| cargo-audit | `dependencies` | Na imagem de ferramentas | Crates Rust; a base é a que o `jgates tools update-data` mantém. |
| cargo test | `tests` e `properties` | Na imagem de ferramentas | Crates Rust. Roda `cargo test --offline` sobre as dependências preparadas no volume do componente e lê a saída estável do libtest: um teste que falha é `cargo-test.test-failed`; uma propriedade do proptest que falha (função em um bloco `proptest!` ou marcada com `#[proptest]`, achada lendo os fontes) é `cargo-test.property-failed` com a entrada mínima que falha, mais as métricas `tests.property.total` e `tests.property.failed` quando o crate usa proptest. Os artefatos de build ficam na pasta da execução e a persistência de falhas do proptest fica desligada, então o projeto não é alterado. O template `rust-cargo-test` é adicionado pelo `jgates init` aos componentes Rust. Os testes e build scripts executam, então o resultado é autodeclarado no `jgates ci`. |

Para uma ferramenta que você mesmo prepara, o adaptador, as versões suportadas, os links oficiais e uma verificação de
prontidão já vêm prontos; o `jgates status` e o plano informam o que falta. Nada é baixado enquanto uma execução está em
andamento. Para uma ferramenta ou linguagem que não está na tabela, veja [suas próprias ferramentas](extension.pt-BR.md).

## Subdimensões do Quality

Os seis domínios dos mascotes se organizam em subdimensões. Elas só organizam a apresentação: uma verificação tem um
domínio primário e uma subdimensão, então nenhuma execução é contada duas vezes, e uma subdimensão sem verificação
selecionada aparece como não coberta.

- Quality: lint, types, builds, maintainability, reliability, api-compatibility.
- Security: injection, authorization, tenant-isolation, secrets, cryptography, privacy, business-logic, runtime-evidence.
- Dependencies: vulnerabilities, licenses, supply-chain.
- Tests: unit-integration, contracts, properties, mutation, regressions, post-patch.
- Architecture: layer-boundaries, cycles, cross-module-effects, invariants.
- Infrastructure: iac, ci-cd, deployment, images.

## Limitações

- Uma linha `customer-setup-required` não é provada aqui; a matriz diz isso em vez de esconder.
- O macOS não foi testado em máquina real.
- Um `timeoutSeconds` por instância no `tools.yml` é ignorado pelos adaptadores externos.
- As regras oficiais do registro do Semgrep têm uma licença que não permite redistribuição, então nunca são distribuídas.
- Os dados offline do OSV cobrem só npm, PyPI, Go, crates.io e NuGet; o Trivy usa as verificações embutidas; os testes e2e do Playwright rodam só no Chromium (veja [limitações](limitations.pt-BR.md)).
