# API pública de imóveis — `/v1`

API REST somente-leitura para parceiros externos consumirem a base de imóveis da
Seu Imóvel na Represa. Roda em Cloud Function v2, `us-central1`.

Arquivos:

| Arquivo | O que é |
|---|---|
| `apiImoveis.js` | As 3 Cloud Functions (HTTP + trigger + cron) |
| `apiImoveisCore.js` | Lógica pura: whitelist, normalização, filtros. Sem Firebase |
| `testeApiImoveis.js` | 86 testes. `node testeApiImoveis.js`, sem credencial nem rede |
| `criarChaveParceiro.js` | Gera/lista/desativa chave de parceiro. Roda na máquina do Vinicius |

---

## Estado atual

**No ar desde 06/08/2026** (commit `854d566`). O invoker público já foi liberado
e o catálogo já se gerou sozinho. Testado end-to-end contra produção: 26
asserções, incluindo fotos do Drive e do Storage abrindo de fato.

```
https://us-central1-seuimovelnarepresa.cloudfunctions.net/apiImoveis
```

**Falta um passo para o parceiro conseguir usar:** criar a chave dele. Enquanto
`api_keys` estiver vazia, a API responde 401 a tudo — que é o comportamento
correto, mas significa que ela ainda não serve ninguém.

```bash
node criarChaveParceiro.js "Imobiliaria X" https://www.imobiliariax.com.br
```

### ⚠️ Ao mexer nas functions no futuro

O workflow roda `firebase deploy --only functions --force`, e o `--force`
**deleta do projeto qualquer function que não esteja no fonte**. Em 04/08/2026 a
cópia local do `index.js` estava desatualizada e teria apagado
`triggerSiteRebuildBairros` e `backfillWatermark` do ar.

Antes de commitar, confirme quais functions o deploy vai enxergar:

```bash
node -e "const m=require('./index.js');console.log(Object.keys(m).sort())"
```

Devem aparecer 7: `apiImoveis`, `backfillWatermark`, `flushCatalogoImoveis`,
`flushPendingRebuilds`, `rebuildCatalogoImoveis`, `triggerSiteRebuild`,
`triggerSiteRebuildBairros`. No log do Actions, qualquer
`Successful delete operation` é sinal de cancelar.

O workflow só dispara em push que toca `index.js`, `package.json`,
`firebase.json`, `.firebaserc` ou o próprio workflow — mudança só de README ou
dos arquivos da API não redeploya. Para forçar, use "Run workflow" na aba Actions.

### Invoker público (já aplicado)

Functions Gen2 sobem privadas. O binding abaixo já foi feito para `apiImoveis`;
fica registrado caso precise refazer:

```bash
gcloud run services add-iam-policy-binding apiimoveis --region=us-central1 --member=allUsers --role=roles/run.invoker --project=seuimovelnarepresa
```

Isso torna o *endpoint* alcançável — a autenticação continua sendo a `X-API-Key`.
Não rode isso para `rebuildCatalogoImoveis` nem `flushCatalogoImoveis`: essas
duas não são HTTP e devem continuar privadas.

---

## Como funciona por dentro

```
properties/{id} muda
        ↓
rebuildCatalogoImoveis (trigger, debounce 30 s)
        ↓
api_catalog/meta + api_catalog/chunk_0..N     ← só os publicados, já filtrados
        ↓
apiImoveis (HTTP)  →  cache em memória da instância (60 s)
        ↓
parceiro
```

**Custo de leitura.** Era o problema da decisão 2. Agora:

| Situação | Reads no Firestore |
|---|---|
| Request com cache quente (< 60 s) | **0** |
| Cache expirado, catálogo inalterado | 1 (só o `meta`) |
| Catálogo mudou | 1 + 2 chunks |
| Rebuild do catálogo | ~109, algumas vezes por dia |

O parceiro chamando de minuto em minuto sai de centenas de milhares de reads/dia
para ~1.400.

> **São 109 imóveis publicados, não 236.** O briefing usava 236, que é o total da
> coleção `properties`; só 109 têm `publishToSite === true`. Se isso for
> inesperado, vale conferir no CRM quantos imóveis deveriam estar publicados.

**Por que chunks e não um doc só.** Com `media[]` cheio, um doc único passaria
perto do teto de 1 MB por documento do Firestore. `CHUNK_SIZE = 60` dá 2 docs
para os 109 atuais (476 KB no total). O código loga `ERROR` se algum chunk passar
de 900 KB.

**Latência.** Uma edição no CRM aparece na API em até 30 s (debounce). Se dois
imóveis forem editados em sequência, o segundo marca o catálogo como `sujo` e o
cron `flushCatalogoImoveis` regenera em até 15 min. Esse cron também faz a
primeira geração sozinho depois do deploy — não precisa popular nada à mão.

---

## Endpoints

Base: `https://us-central1-seuimovelnarepresa.cloudfunctions.net/apiImoveis`

Todos exigem o header `X-API-Key`. Todos respondem `Cache-Control: public, max-age=300`.

### `GET /v1/imoveis`

| Parâmetro | Tipo | Observação |
|---|---|---|
| `cidade`, `bairro` | string | Casa sem acento e sem ligar para maiúsculas |
| `categoria` | string | `casa`, `chacara`, `terreno`, `apartamento`, `comercial`, `obra` |
| `finalidade` | string | `venda` ou `locacao`. Imóvel `ambos` casa com os dois |
| `precoMin`, `precoMax` | number | Bate em `precoVenda`; com `finalidade=locacao`, em `precoLocacao` |
| `quartosMin` | int | |
| `aptoFinanciamento` | `true`/`false` | |
| `dealStatus` | string | `disponivel`, `em_negociacao`, `vendido`, `locado` |
| `recursos` | csv | Exige **todos**. Ex.: `piscina,vista_represa` |
| `atualizadoDesde` | ISO 8601 | Para sincronização incremental |
| `incluirIndisponiveis` | `true` | Ver nota abaixo |
| `ordenar` | string | `preco_asc`, `preco_desc`. Padrão: mais recentes primeiro |
| `page`, `limit` | int | `limit` padrão 50, teto 200 |

> **Nota — vendidos e locados ficam fora por padrão.** Julgamento meu: uma
> listagem de parceiro que mostra imóvel vendido gera atendimento perdido.
> `incluirIndisponiveis=true` traz tudo, e o campo `dealStatus` continua na
> resposta. Se preferir o contrário como padrão, é uma linha em
> `apiImoveisCore.js` (`aplicarFiltros`).

### `GET /v1/imoveis/{codigo}`

Busca por `codigo` (ex.: `SIR-1042`). **Não existe busca por slug** — o campo
`slug` não existe em `properties`, só na coleção `bairros`. O briefing listava
`slug` como campo exponível; isso está incorreto.

### `GET /v1/bairros`

Bairros com pelo menos um imóvel disponível, derivados do próprio catálogo
(zero leitura extra):

```json
{ "data": [{ "bairro": "Riviera de Santa Cristina XIII", "cidade": "Águas de Santa Bárbara", "totalImoveis": 42 }],
  "meta": { "total": 1, "catalogoGeradoEm": "2026-08-04T18:00:00.000Z" } }
```

### `GET /v1/status`

Saúde da API e frescor do catálogo. Bom para o parceiro monitorar.

---

## Contrato de dados

```json
{
  "data": [
    {
      "codigo": "SIR-1042",
      "titulo": "Casa com vista para a represa",
      "descricao": "Casa em condomínio fechado.",
      "categoria": "casa",
      "finalidade": "venda",
      "precoVenda": 850000,
      "precoLocacao": null,
      "cidade": "Águas de Santa Bárbara",
      "bairro": "Riviera de Santa Cristina XIII",
      "localizacaoAproximada": { "lat": -22.718, "lng": -46.552, "precisaoMetros": 110 },
      "quartos": 3, "suites": 1, "banheiros": 2, "vagas": 2,
      "areaTerreno": 1000, "areaConstr": 180,
      "recursos": ["piscina", "vista_represa"],
      "aptoFinanciamento": true,
      "dealStatus": "disponivel",
      "fotos": [
        { "url": "https://lh3.googleusercontent.com/d/<id>=w1600",
          "thumb": "https://lh3.googleusercontent.com/d/<id>=w400" }
      ],
      "atualizadoEm": "2026-07-30T12:00:00.000Z"
    }
  ],
  "meta": { "page": 1, "limit": 50, "total": 109, "totalPaginas": 3,
            "catalogoGeradoEm": "2026-08-06T05:31:03.814Z" }
}
```

Erro:

```json
{ "error": { "codigo": "chave_invalida", "mensagem": "Chave invalida ou desativada." } }
```

| Status | `codigo` |
|---|---|
| 401 | `chave_ausente`, `chave_invalida` |
| 404 | `nao_encontrado`, `rota_desconhecida` |
| 405 | `metodo_nao_permitido` |
| 429 | `rate_limit`, `cota_diaria` |
| 500 | `erro_interno` |
| 503 | `catalogo_indisponivel` |

### O que nunca sai

Whitelist explícita em `apiImoveisCore.js` → `paraPublico()`. Nada entra na
resposta que não esteja escrito nome por nome lá. Fora, por decisão:

`ownerName`, `ownerPhone`, `ownerEmailContact`, `ownerNotes`, `ownerEmail`,
`submitterInfo` (CPF e RG), `authorizationAccepted`, `commissionPayment`,
`driveFolderId`, `media[].driveFileId`, `prevContact`, `partnerFavoritedBy`,
`sourceUrl`, `wpPostId`, `wpUrl`, **`endereco`**, **`lat`/`lng` exatos**.

`testeApiImoveis.js` monta um doc com todos esses campos preenchidos e afirma
que nenhum dos valores aparece no JSON. Rode depois de qualquer mexida na
whitelist.

**Fora da whitelist mas talvez desejáveis** — `videoLinks[]` e `estilo`
(`moderna`/`campo`/`clássica`) existem em `properties`, são dados públicos de
marketing e não estavam nem na lista de expor nem na de bloquear do briefing.
Ficaram de fora por disciplina de whitelist. Incluir é acrescentar duas linhas
em `paraPublico()`.

### Localização — decisão 1

Endereço exato nunca sai, sem flag e sem exceção. A resposta traz cidade,
bairro e `localizacaoAproximada` com lat/lng arredondados a 3 casas decimais
(~110 m). Serve para montar mapa e busca por região; não serve para bater na
porta do proprietário. O campo `endereco` não existe na resposta.

### Fotos — decisão 3

`url` (w1600) e `thumb` (w400), prontas para uso. Duas origens:

- **Firebase Storage** (195 fotos): `downloadUrl` original, já com marca d'água
  do backfill v5.171-187.
- **Google Drive** (1.495 fotos): `https://lh3.googleusercontent.com/d/{id}=w1600`,
  **sem marca d'água**.

(Números do catálogo em 06/08/2026: 1.690 fotos nos 109 imóveis publicados,
nenhum imóvel sem foto.)

Validado em 04/08/2026, sem nenhuma sessão Google ativa: `lh3` responde
`200 image/jpeg` para os três `driveFileId` testados. É o mesmo caminho que o
site estático `seuimovelnarepresa.com.br` já usa em produção. Não precisa
espelhar foto nenhuma no Storage.

O `driveFileId` nunca chega ao parceiro: a URL é montada na geração do catálogo,
então o id cru não existe em nenhum caminho de resposta.

Pendência conhecida: as fotos do Drive saem sem marca d'água. Um backfill futuro
resolve sem tocar na API.

---

## Autenticação e chaves

`api_keys/{keyId}`:

```json
{
  "hash": "<sha256 da chave>",
  "nome": "Imobiliária X",
  "ativo": true,
  "origins": ["https://www.imobiliariax.com.br"],
  "limitePorMinuto": 120,
  "limiteDiario": 20000,
  "criadoEm": "...", "ultimoUso": "...", "chamadasHoje": 0
}
```

A chave em texto nunca é gravada. Criar:

```bash
node criarChaveParceiro.js "Imobiliaria X" https://www.imobiliariax.com.br
```

Listar / desativar:

```bash
node criarChaveParceiro.js --listar
```

```bash
node criarChaveParceiro.js --desativar <keyId>
```

Desativar leva até 5 min para valer em todas as instâncias (cache de chave).
Para corte imediato, delete o doc e force um redeploy.

### CORS

`Access-Control-Allow-Origin` só é devolvido se a origem estiver em `origins`
daquela chave. Nunca `*`. Sem `origins`, a chave só funciona server-to-server —
o navegador barra, o servidor do parceiro não.

O preflight `OPTIONS` é liberado sem chave: o navegador não manda header
customizado no preflight, então não há como autenticar ali. Liberar o preflight
não expõe dado — o `GET` real continua exigindo chave válida e origem cadastrada.

O WAF do Cloudez não interfere: ele bloqueia fetch cross-site originado em
`app.seuimovelnarepresa.com.br`, e o parceiro chama de outro domínio ou do
servidor dele.

### Rate limit — o que ele é e o que não é

Contadores em memória por instância: 120 req/min e 20.000 req/dia por chave.
Com `maxInstances: 10`, o teto real é até 10× isso no pior caso. **É controle de
custo, não controle de segurança.**

O uso vai para o Firestore no máximo 1× a cada 5 min por chave/instância —
gravar a cada request custaria mais que as leituras que o catálogo economiza.
Logo, `chamadasHoje` é aproximado e serve para acompanhamento, não para cobrança.

---

## Testes

```bash
node testeApiImoveis.js
```

86 asserções, sem credencial e sem rede. Cobre vazamento de PII, arredondamento
de coordenada, montagem de URL de foto, filtro de publicação (rascunho,
`pending_review`, `rejected`), preço em pt-BR (`"850.000,00"`), todos os filtros
da listagem, ordenação e documento degenerado.
