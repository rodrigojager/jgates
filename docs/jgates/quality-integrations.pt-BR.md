# JGates: integrações do Quality e a matriz de capacidades

As novas integrações do Quality estão no catálogo padrão (interface e CLI) por padrão. Se uma delas roda depende da
detecção da stack, do perfil, do rigor, do escopo, dos pré-requisitos e das suas escolhas em cada execução. O Quality
nunca chama um modelo. Nenhuma integração é instalada durante uma execução: `jgates doctor --fix` prepara as que o JGates
pode preparar, e as demais ficam por sua conta.

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
ferramenta ou a preparação, então a suíte padrão não a prova), `unsupported` ou `not-applicable`. A linha também lista os
pré-requisitos, as versões da ferramenta e as limitações. `--units` acrescenta a visão por unidade.
`jgates tools distribution` verifica se o registro de distribuição de cada adaptador (distribuído, preparado de fonte
autorizada ou fornecido pelo cliente) está completo e se cada pacote distribuído cumpre os termos da sua licença.

## As integrações

| Integração | Capacidade | Distribuição | Stacks e observações |
| --- | --- | --- | --- |
| Semgrep com o pacote de regras do JGates | `sast` | O Semgrep é fornecido pelo cliente; o pacote é distribuído | `tools.<id>.rulePack: jgates` seleciona o pacote (`jgates/packs/semgrep/jgates-semgrep`, regras originais do JGates, MIT). Validado para Python, JavaScript e TypeScript. As regras oficiais do registro do Semgrep nunca são distribuídas. |
| zizmor | `ci-cd` | Preparado de fonte autorizada | Audita workflows do GitHub Actions. |
| oasdiff | `api-compatibility` | Fornecido pelo cliente | Precisa de um arquivo OpenAPI 3 e de uma referência git ou arquivo como base. Sem extração de contrato a partir do código. |
| Verificação de build | `typecheck` | Fornecido pelo cliente | Validado para TypeScript, Python, Go, Rust e C#; JavaScript, F# e Visual Basic não são suportados. O template `typescript-tsc` ativa em qualquer `tsconfig.json`. |
| CodeQL | `dataflow` | Fornecido pelo cliente | O JGates distribui só o adaptador. Você instala o CLI do CodeQL (2.15+, `JGATES_CODEQL` ou o PATH) e tem a licença de uso para o seu repositório. O adaptador é exercitado com um substituto que reproduz um SARIF no formato do CodeQL; um CodeQL real não roda na suíte padrão. |
| Schemathesis | `api-contract` | Preparado de fonte autorizada | Precisa de um arquivo OpenAPI 3 e de um alvo HTTP em execução. |
| ZAP | `dast` | Fornecido pelo cliente | Modos passivo e ativo contra um alvo HTTP em execução; o modo ativo ataca o alvo, então use só em sistemas seus. Precisa do Docker e da imagem do ZAP. |
| Teste de mutação | `mutation` | Fornecido pelo cliente | Validado para JavaScript e Python; TypeScript depende da sua preparação. |
| Cadeia de suprimentos | `supply-chain` | Distribuído | Lê lockfiles (npm e Python); aponta scripts de instalação, hashes de integridade ausentes e fontes sem versão fixa ou não confiáveis. |
| Trivy em modo imagem | `dependencies` e `images` | Preparado de fonte autorizada | Examina uma imagem de contêiner, não só o sistema de arquivos. |
| govulncheck | `dependencies` | Fornecido pelo cliente | Módulos Go. |
| cargo-audit | `dependencies` | Fornecido pelo cliente | Crates Rust. |

Para uma ferramenta fornecida pelo cliente, o adaptador, as versões suportadas, os links oficiais de aquisição e preparação
e uma verificação de prontidão já vêm prontos; `jgates doctor` informa o que falta. Nada é baixado enquanto uma execução
está em andamento.

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
