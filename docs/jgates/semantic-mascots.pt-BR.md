# Mascotes do Semantic

O gate Semantic tem seis mascotes próprios, um por fase do método de auditoria de segurança da Cloudflare. São modelos 3D
animados da mesma família dos seis mascotes do Quality (vinil acetinado, os olhos, braços e botas da família) com uma
cápsula transparente com um cérebro no alto; os mascotes do Quality nunca mostram trabalho de IA e estes nunca mostram um
domínio do Quality.

| Mascote | Fase | Etapas que mostra |
|---|---|---|
| Atlas (bússola) | Reconhecimento: mapear o código, suas superfícies e fronteiras de confiança, e planejar a cobertura | `reconnaissance`, `coverage-planning`, `semantic-context` |
| Trace (lupa-serpente) | Caça guiada pela cobertura: caçar candidatos e achar as lacunas de cobertura | `hunting`, `coverage-critic`, `hunt`, `semantic-review` |
| Verdict (martelo de juiz) | Validação dos candidatos: tentar refutar cada candidato pelo código-fonte | `refutation`, `validate` |
| Fit (caixa de encaixe) | Saída estruturada: registros no formato do esquema e a conferência do registro de cobertura | `structured-output`, ou nenhuma (feita pelo JGates) |
| Seal (carimbo) | Verificação independente: reconferir os registros finais em contexto novo | `verification` |
| Folio (prancheta de relatório) | Relatório neutro quanto ao alvo: o relatório legível a partir dos registros verificados | `reporting`, `report`, ou nenhuma (feita pelo JGates) |

Cada etapa pertence a exatamente um mascote. O id da etapa é lido sem o prefixo do módulo (`security-audit/hunting`
vira `hunting`).

## De onde vem o agrupamento

- **Auditoria de segurança da Cloudflare** (fluxo fixado em `jgates/vendor/cloudflare-security-audit/prompts`): os seis
  mascotes são as suas seis fases. O reconhecimento e o plano de cobertura (a síntese da fase 1) são o Atlas; a onda de
  caça e o seu crítico de cobertura são a fase 2, o Trace; a refutação por candidato é a fase 3, o Verdict; a verificação
  reconfere cada registro mantido em contexto novo, fase 5, o Seal. As fases 4 (saída estruturada) e 6 (relatório) são
  código do JGates (ele valida e grava os registros e depois gera os relatórios), então o Fit e o Folio em geral não têm
  etapa de modelo.
- **Revisão geral** (os prompts do Semantic em `semantic-gate/templates`, executados pelas etapas `hunt` / `validate` do
  módulo de investigação embutido): `hunt` examina e reporta candidatos (Trace), `validate` julga cada candidato em
  contexto novo (Verdict). A etapa de coleta de contexto vai para o Atlas. Ela não tem verificação independente.
- Um id de etapa que não está na lista também recebe um mascote, o da fase mais próxima: etapa em modo de verificação ou id
  de verificação vai para o Seal, id de relatório/resumo para o Folio, id de saída/formato/esquema/registro para o Fit,
  etapa `validate` ou id de refutação/crítica para o Verdict, id sobre reconhecimento/plano/contexto/escopo para o Atlas, o
  resto para o Trace. Um módulo novo aparece sem mudança de código.
- Execuções guardadas com os quatro primeiros mascotes (`scout`, `tracker`, `challenger`, `verifier`) continuam legíveis:
  esses ids viram Atlas, Trace, Verdict e Seal.

## Estados

Aguardando, trabalhando, concluído, incompleto, falhou e cancelado. Um selo no canto repete o estado, então a cor não é o
único sinal.

- `concluído` exige todas as etapas do mascote completas. Etapa ausente, orçamento esgotado ou etapa não executada mostram
  `incompleto`; etapa inválida, com tempo esgotado ou com erro mostra `falhou`.
- Uma fase sem etapa própria aguarda enquanto a execução roda. Quando a execução para, uma fase de modelo sem etapa fica
  `incompleto` (não aconteceu, como a verificação numa revisão geral), enquanto o Fit e o Folio, feitos pelo JGates
  depois das etapas de modelo, ficam `concluído` quando todas as etapas da execução terminaram e `incompleto` se não.
- Uma execução que não está mais rodando nunca deixa um mascote aguardando ou trabalhando.
- Uma execução cancelada nunca mostra um mascote como concluído: etapas que terminaram antes do cancelamento mostram
  `incompleto` (a evidência é mantida, a execução não está completa) e as demais mostram `cancelado`.

## Desenho, acessibilidade e temas

Cada mascote é uma vista em três quartos com a iluminação do estudo, desenhada por um único contexto WebGL compartilhado
na tela (canvas) do próprio mascote. Um mascote que aparece pela primeira vez mostra o seu estado como ele é; quando o
estado muda, ele faz a reação do novo estado por alguns segundos e depois fica numa pose que depende só do estado. Só
"trabalhando" continua em movimento (e o Atlas depois de uma falha, cuja agulha nunca para), e quadros são desenhados só
enquanto algo se move (um mascote parado é redesenhado a partir de uma cópia). O movimento segue o dos mascotes do
Quality: fases com aceleração e desaceleração e molas amortecidas, um pequeno salto e olhos em arco no sucesso, um recuo
e sobrancelhas preocupadas na falha, uma inclinação e um olho meio fechado na dúvida. Os braços são mangueiras
(rubber hose), como nos desenhos de onde a família vem: uma mangueira de espessura uniforme que chega à mão num único
arco e nunca mostra cotovelo, terminando numa luva simples na cor do corpo. Em repouso pendem ao lado do corpo; uma mão
à frente do corpo é alcançada contornando o corpo, nunca através dele.

| Mascote | Trabalhando | Concluído | Incompleto | Falhou |
|---|---|---|---|---|
| Atlas | procura o norte: a agulha (metade vermelha para o norte, metade clara para o sul, sobre a rosa fixa) oscila para um lado e para o outro, no máximo 20 graus, cada vez com um ângulo e uma duração e um pequeno tremor ao parar | a agulha volta ao norte | a agulha hesita e para fora do norte | a agulha gira sem parar como uma bússola assombrada, ora disparando, ora quase parando |
| Trace | caça: a lente serpenteia num rastro, dá o bote num achado e o chocalho vibra | um aceno, um brilho na lente, uma sacudida do chocalho | a cabeça pende de lado: perdeu o rastro | recua e deixa a cabeça cair |
| Verdict | segura uma balança: o candidato (um cubo) a faz tombar, a evidência (outro cubo) a traz de volta, e ela para nivelada | salta, desce como um martelo de juiz até a face inteira da cabeça ficar chapada na base, e fica apoiado nela | um prato continua embaixo, só com o candidato | a balança sacode e fica pendurada para um lado, vazia |
| Fit | pega uma massa sem forma (cada uma virada de um jeito), modela em três batidas no formato de um encaixe e a assenta; três registros, depois o próximo lote | todo encaixe tem o seu registro | um registro encaixado e outro pela metade | o registro quadrado emperra no encaixe triangular |
| Seal | carimba uma marca de aprovado depois da outra ao longo do recibo | três marcas em fila | paira sobre um recibo com uma marca | a marca que deixa é um X vermelho |
| Folio | escreve as duas linhas do relatório com um lápis da sua cor e levanta as barras do gráfico | o relatório inteiro, as barras comemoram | um relatório que para na metade | o gráfico desaba |

Enquanto o mascote trabalha, correntes correm pelas trilhas do cérebro na cápsula, cada trilha na sua velocidade e
algumas no sentido contrário, num relógio que todos os mascotes compartilham; o cérebro fica aceso depois de concluir, e
dá três faíscas lentas e apaga numa falha. Um mascote aguardando fica esmaecido e só respira enquanto outro trabalha; um
cancelado se acomoda e descansa. "Trabalhando" também faz o selo pulsar. Com `prefers-reduced-motion` nada se move: cada
estado mostra a sua pose parada (em "trabalhando", um momento da ação).

Dois mascotes têm uma segunda versão guardada para comparação (`variants` em
`jgates/ui/src/mascots/semantic/catalog.js`; o primeiro nome é o que aparece): o Verdict pesando com as palmas e
saltando para bater na base em vez de segurar uma balança, e o Seal com braços em vez de sem.

Onde não há WebGL, cada mascote mostra a sua imagem pré-renderizada, parada
(`jgates/ui/src/mascots/semantic/fallback/`, gerada a partir dos mesmos modelos por
`node jgates/scripts/render-semantic-mascots.mjs`) com o mesmo rótulo e o mesmo selo. As imagens têm fundo transparente,
então os temas claro e escuro usam o mesmo desenho.

Todo mascote tem `role="img"` e um rótulo acessível com o nome, a fase e o estado, em inglês e português.
