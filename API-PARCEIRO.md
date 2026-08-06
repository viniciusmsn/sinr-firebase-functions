# API de Imóveis — Seu Imóvel na Represa

Documentação para integração de parceiros. API REST somente leitura: devolve o
catálogo de imóveis publicados, com fotos prontas para uso.

**Base URL**

```
https://us-central1-seuimovelnarepresa.cloudfunctions.net/apiImoveis
```

Todas as rotas são `GET`. A resposta é sempre JSON com `charset=utf-8`.

---

## 1. Autenticação

Toda requisição precisa do header `X-API-Key` com a chave que enviamos
separadamente.

```
X-API-Key: sua-chave-aqui
```

Sem o header, ou com chave inválida, a resposta é `401`.

**A chave é secreta.** Ela não deve aparecer em código de front-end, repositório
público ou URL. Se ela vazar, avise que emitimos outra e desativamos a antiga.

### De onde chamar

O uso recomendado é **servidor para servidor**: seu backend consulta a API,
guarda o resultado e serve o seu site a partir dele.

Se você precisar chamar direto do navegador, a origem `https://resortsinbrazil.com`
já está liberada por CORS. Qualquer outra origem é recusada — se o site mudar de
domínio ou passar a usar subdomínio, nos avise antes.

### Limites

| Limite | Valor |
|---|---|
| Requisições por minuto | 120 |
| Requisições por dia | 20.000 |

Ao estourar, a resposta é `429`. Os limites são folgados para o uso previsto —
veja a estratégia de sincronização na seção 6 e você ficará muito abaixo deles.

---

## 2. Endpoints

### `GET /v1/imoveis`

Lista os imóveis disponíveis, com filtros e paginação.

**Filtros**

| Parâmetro | Tipo | Descrição |
|---|---|---|
| `cidade` | texto | Compara sem acento e sem diferenciar maiúsculas. `avare` encontra `Avaré` |
| `bairro` | texto | Idem |
| `categoria` | texto | Hoje há `casa`, `terreno`, `chacara` e `obra`. O cadastro também prevê `apartamento` e `comercial`, que podem surgir |
| `finalidade` | texto | `venda` ou `locacao`. Imóveis marcados como `ambos` aparecem nos dois |
| `precoMin` | número | Ver nota sobre preço abaixo |
| `precoMax` | número | Ver nota sobre preço abaixo |
| `quartosMin` | inteiro | Mínimo de quartos |
| `aptoFinanciamento` | `true`/`false` | Aceita financiamento bancário |
| `dealStatus` | texto | `disponivel` ou `em_negociacao`. Com `incluirIndisponiveis=true`, também `vendido` e `locado` |
| `recursos` | lista csv | Exige **todos** os listados. Ex.: `piscina,vista_represa` |
| `atualizadoDesde` | data ISO 8601 | Só imóveis alterados a partir dessa data |
| `incluirIndisponiveis` | `true` | Inclui vendidos e locados, que por padrão ficam de fora |

**Ordenação e paginação**

| Parâmetro | Padrão | Descrição |
|---|---|---|
| `ordenar` | mais recentes | `preco_asc` ou `preco_desc` |
| `page` | `1` | Página, começando em 1 |
| `limit` | `50` | Itens por página. Máximo **200** |

**Nota sobre preço.** `precoMin` e `precoMax` são aplicados ao `precoVenda`. Se
você passar `finalidade=locacao`, passam a ser aplicados ao `precoLocacao`.

**Exemplo**

```
GET /v1/imoveis?cidade=paranapanema&categoria=casa&precoMax=1500000&recursos=piscina&limit=20
```

---

### `GET /v1/imoveis/{codigo}`

Um imóvel específico pelo campo `codigo`.

```
GET /v1/imoveis/RN01
```

Devolve `404` com `codigo: "nao_encontrado"` se o imóvel não existir ou não
estiver mais publicado.

---

### `GET /v1/bairros`

Bairros que têm pelo menos um imóvel disponível. Útil para montar filtros na sua
interface sem precisar varrer o catálogo inteiro.

```json
{
  "data": [
    { "bairro": "Riviera de Santa Cristina XIII", "cidade": "Paranapanema", "totalImoveis": 79 },
    { "bairro": "Riviera de Santa Cristina IV", "cidade": "Arandu", "totalImoveis": 5 },
    { "bairro": "Balneário Costa Azul", "cidade": "Avaré", "totalImoveis": 3 }
  ],
  "meta": { "total": 15, "catalogoGeradoEm": "2026-08-06T05:31:03.814Z" }
}
```

A lista é ordenada por nome do bairro. Cada entrada é uma combinação
cidade + bairro: o mesmo nome de bairro pode aparecer em cidades diferentes,
então use os dois campos juntos como chave, nunca só o `bairro`.

---

### `GET /v1/status`

Verifica se a integração está de pé e quando o catálogo foi gerado pela última
vez. Bom para monitoramento.

```json
{ "data": { "ok": true, "totalImoveis": 109, "catalogoGeradoEm": "2026-08-06T05:31:03.814Z", "parceiro": "RESORTS IN BRAZIL" } }
```

---

## 3. Formato da resposta

Toda listagem vem no mesmo envelope:

```json
{
  "data": [ ... ],
  "meta": {
    "page": 1,
    "limit": 50,
    "total": 109,
    "totalPaginas": 3,
    "catalogoGeradoEm": "2026-08-06T05:31:03.814Z"
  }
}
```

`total` é o número de imóveis que casaram com o filtro, não o tamanho da página.

### Exemplo de imóvel

```json
{
  "codigo": "RN01",
  "titulo": "Chácara pé na areia No Riviera Norte em Arandú",
  "descricao": "Chácara pé na areia com acesso direto à represa Jurumirim...",
  "categoria": "chacara",
  "finalidade": "venda",
  "precoVenda": 2900000,
  "precoLocacao": null,
  "cidade": "Paranapanema",
  "bairro": "Riviera Norte",
  "localizacaoAproximada": { "lat": -23.209, "lng": -49.054, "precisaoMetros": 110 },
  "quartos": 5,
  "suites": 5,
  "banheiros": 6,
  "vagas": null,
  "areaTerreno": 5000,
  "areaConstr": 730,
  "recursos": ["piscina", "churrasqueira", "vista_represa", "pier", "mobiliado"],
  "aptoFinanciamento": true,
  "dealStatus": "disponivel",
  "fotos": [
    { "url": "https://...=w1600", "thumb": "https://...=w400" }
  ],
  "atualizadoEm": "2026-08-06T18:38:44.131Z"
}
```

### Campos

| Campo | Tipo | Observação |
|---|---|---|
| `codigo` | texto | Identificador estável. Use como chave primária |
| `titulo` | texto | |
| `descricao` | texto ou `null` | Texto livre, pode ter quebras de linha |
| `categoria` | texto | `casa`, `terreno`, `chacara`, `obra` (pode crescer) |
| `finalidade` | texto | `venda`, `locacao` ou `ambos` |
| `precoVenda` | número ou `null` | Em reais, sem centavos |
| `precoLocacao` | número ou `null` | Em reais, valor mensal |
| `cidade` | texto | |
| `bairro` | texto ou `null` | |
| `localizacaoAproximada` | objeto | `{ lat, lng, precisaoMetros }`. Ver seção 4 |
| `quartos` | inteiro ou `null` | |
| `suites` | inteiro ou `null` | |
| `banheiros` | inteiro ou `null` | |
| `vagas` | inteiro ou `null` | |
| `areaTerreno` | número ou `null` | Em m² |
| `areaConstr` | número ou `null` | Em m² |
| `recursos` | lista de texto | Ver lista completa abaixo |
| `aptoFinanciamento` | booleano | Nunca `null` |
| `dealStatus` | texto | `disponivel` ou `em_negociacao`. Vendidos e locados não aparecem, salvo com `incluirIndisponiveis=true` |
| `fotos` | lista de objetos | Ver seção 5 |
| `atualizadoEm` | data ISO 8601 ou `null` | Use para sincronização incremental |

> ### ⚠️ Campos nulos são comuns — trate isso desde o início
>
> Boa parte do catálogo não tem todos os atributos preenchidos. Situação real
> hoje, em 109 imóveis:
>
> | Campo | Vem `null` em |
> |---|---|
> | `vagas` | 73% dos imóveis |
> | `areaConstr` | 58% |
> | `banheiros` | 52% |
> | `suites` | 49% |
> | `quartos` | 45% |
> | `descricao` | 17% |
> | `areaTerreno` | 13% |
>
> Isso é esperado: terrenos não têm quartos, e parte do acervo foi cadastrada
> sem a ficha completa. Sua interface precisa lidar com ausência, não exibir
> "0 quartos" nem quebrar.
>
> **Consequência nos filtros:** `quartosMin=2` remove todo imóvel com `quartos`
> nulo — hoje isso é quase metade do catálogo. O mesmo vale para `precoMin` e
> `precoMax` com preço nulo. Use filtros numéricos só quando o usuário pedir
> explicitamente.

### Valores possíveis de `recursos`

```
condominio          portaria_24h        churrasqueira       piscina
mobiliado           vista_represa       wifi                energia_fotovoltaica
aquecimento_piscina pomar               pet_friendly        boiler
quadra              fire_pit            pier                rampa
poco                campo_futebol
```

A lista pode crescer com o tempo. Trate valor desconhecido como recurso genérico
em vez de erro.

---

## 4. Localização

A API **não fornece o endereço exato** dos imóveis. É uma política nossa, para
proteger os proprietários de abordagem direta.

O que você recebe é `localizacaoAproximada`: coordenadas arredondadas com
precisão de cerca de **110 metros**, além de cidade e bairro, que são exatos.

Isso é suficiente para posicionar o imóvel num mapa, mostrar a região e filtrar
por proximidade. Não é suficiente — e não deve ser apresentado — como o endereço
da propriedade. Sugerimos exibir como um círculo ou área aproximada no mapa, não
como um pino exato.

---

## 5. Fotos

Cada item de `fotos` tem duas URLs, prontas para uso direto em `<img src>`. Não
exigem autenticação, chave nem cabeçalho especial.

```json
{ "url": "https://...", "thumb": "https://..." }
```

- `url` — imagem em resolução alta, para a página do imóvel
- `thumb` — versão reduzida, para listagens e cards

**Atenção:** para parte do acervo, `thumb` é idêntico a `url`. São fotos
hospedadas em outro serviço, que não oferece redimensionamento. Não assuma que
`thumb` é sempre leve — se o peso importar na sua listagem, use
`loading="lazy"` e defina dimensões no CSS.

A ordem da lista é a ordem definida por nós; a primeira foto é a de capa.
A quantidade varia bastante (alguns imóveis têm mais de 50 fotos).

Recomendamos **não** copiar as imagens para o seu servidor: as URLs são estáveis
e servidas por CDN. Se você espelhar, corre o risco de mostrar foto
desatualizada depois de uma troca no nosso cadastro.

---

## 6. Como sincronizar

O catálogo é regenerado do nosso lado poucos minutos após qualquer alteração, e
as respostas trazem `Cache-Control: public, max-age=300` (5 minutos).

**Não consulte a API a cada requisição do seu site.** O padrão recomendado:

1. **Carga inicial:** percorra `GET /v1/imoveis?limit=200&page=N` até esgotar as
   páginas e guarde tudo no seu banco.
2. **Atualização periódica:** de hora em hora (ou algumas vezes ao dia), chame
   com `atualizadoDesde` igual ao maior `atualizadoEm` que você já tem:

   ```
   GET /v1/imoveis?atualizadoDesde=2026-08-06T18:38:44.131Z&limit=200
   ```

   Isso devolve só o que mudou.
3. **Remoções:** imóveis vendidos, locados ou despublicados simplesmente
   deixam de aparecer na listagem — eles não voltam marcados como removidos.
   Por isso, uma vez por dia, vale refazer a listagem completa de `codigo` e dar
   baixa no que sumiu.

O campo `meta.catalogoGeradoEm` indica quando nosso catálogo foi montado. Se ele
parar de avançar por muitas horas, algo está errado do nosso lado — pode nos
avisar.

---

## 7. Erros

Todo erro vem no mesmo formato:

```json
{ "error": { "codigo": "chave_invalida", "mensagem": "Chave invalida ou desativada." } }
```

| HTTP | `codigo` | O que fazer |
|---|---|---|
| 401 | `chave_ausente` | Faltou o header `X-API-Key` |
| 401 | `chave_invalida` | Chave errada ou desativada. Fale conosco |
| 404 | `nao_encontrado` | O `codigo` não existe ou saiu do ar |
| 404 | `rota_desconhecida` | Confira a URL e o prefixo `/v1` |
| 405 | `metodo_nao_permitido` | A API só aceita `GET` |
| 429 | `rate_limit` | Passou de 120/min. Espere e tente de novo |
| 429 | `cota_diaria` | Passou de 20.000/dia |
| 500 | `erro_interno` | Erro nosso. Se persistir, avise |
| 503 | `catalogo_indisponivel` | Indisponibilidade temporária. Tente em alguns minutos |

Em `429` e `503`, faça nova tentativa com espera progressiva (por exemplo 1s, 
2s, 4s), não em laço imediato.

---

## 8. Exemplos

**curl**

```bash
curl -H "X-API-Key: SUA_CHAVE" "https://us-central1-seuimovelnarepresa.cloudfunctions.net/apiImoveis/v1/imoveis?limit=5"
```

**Node.js**

```js
const BASE = 'https://us-central1-seuimovelnarepresa.cloudfunctions.net/apiImoveis';

async function buscarImoveis(params = {}) {
  const qs = new URLSearchParams({ limit: 200, ...params });
  const resp = await fetch(`${BASE}/v1/imoveis?${qs}`, {
    headers: { 'X-API-Key': process.env.SINR_API_KEY },
  });
  if (!resp.ok) {
    const erro = await resp.json().catch(() => ({}));
    throw new Error(`${resp.status}: ${erro.error?.codigo || 'desconhecido'}`);
  }
  return resp.json();
}

// Percorre todas as páginas
async function baixarTudo() {
  const todos = [];
  for (let page = 1; ; page++) {
    const { data, meta } = await buscarImoveis({ page });
    todos.push(...data);
    if (page >= meta.totalPaginas) break;
  }
  return todos;
}
```

**PHP**

```php
$base = 'https://us-central1-seuimovelnarepresa.cloudfunctions.net/apiImoveis';
$ch = curl_init("$base/v1/imoveis?limit=200");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER     => ['X-API-Key: ' . getenv('SINR_API_KEY')],
]);
$resposta = json_decode(curl_exec($ch), true);
curl_close($ch);

foreach ($resposta['data'] as $imovel) {
    echo $imovel['codigo'] . ' - ' . $imovel['titulo'] . PHP_EOL;
}
```

---

## 9. Versionamento e suporte

O prefixo `/v1` é o contrato. Dentro dele podemos **acrescentar** campos novos,
então seu código deve ignorar campos que não conhece em vez de quebrar.
Remoção de campo ou mudança de significado só aconteceria em um `/v2`, com aviso
prévio.

Dúvidas, problemas ou pedido de campo adicional: fale com o Vinicius pelo canal
que já usamos.
