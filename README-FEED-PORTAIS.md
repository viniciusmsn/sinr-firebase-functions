# Feed de portais — ZAP, VivaReal e OLX

Um XML no padrão **VRSync** que o Canal Pro (Grupo OLX) baixa duas vezes por dia
e transforma em anúncios. Uma URL só alimenta ZAP e VivaReal; a OLX entra pelo
mesmo Canal Pro quando o plano contratado é multiportal — a documentação do feed
não cita a OLX, então isso é questão de contrato, não de formato.

Especificação seguida: <https://developers.grupozap.com/feeds/vrsync/> (lida em 16/11/2026).

| Arquivo | O que é |
|---|---|
| `feedPortais.js` | A Cloud Function HTTP `feedPortais` |
| `feedPortaisCore.js` | Regras do portal, mapeamentos e geração do XML. Sem Firebase |
| `feedPortaisAdmin.js` | Diagnóstico, configuração, CEPs e URL secreta. Roda na máquina do Vinicius |
| `testeFeedPortais.js` | 127 testes das regras |
| `testeFeedPortaisHttp.js` | 31 testes da function de ponta a ponta, com Firestore de mentira |

## Colocar no ar, do zero

Tudo de dentro desta pasta, no PowerShell.

```
node feedPortaisAdmin.js diagnostico --lista
node feedPortaisAdmin.js configurar --nome "Seu Imóvel na Represa" --email EMAIL --telefone "TELEFONE" --site https://seuimovelnarepresa.com.br --modo marcados
node feedPortaisAdmin.js cep "Paranapanema" "Riviera de Santa Cristina XIII" 18727-200
node feedPortaisAdmin.js marcar CODIGO1 CODIGO2
node feedPortaisAdmin.js criar-url "Canal Pro"
```

Estado gravado em 16/11/2026: modo `marcados`, contato do site
(`contato@seuimovelnarepresa.com.br`, (14) 99127-0594) e CEP do Riviera de Santa
Cristina XIII = `18727-200` (Setor Marina), por decisão do Vinicius.

A última linha imprime a URL do XML **uma única vez**. É ela que vai no Canal Pro
(Integração → carga por XML). O robô do portal se identifica como
`VivaRealBot/1.0`; depois da primeira leitura, `node feedPortaisAdmin.js listar`
mostra data, hora e quantos anúncios ele levou.

## O que entra e o que fica de fora

Candidato é todo imóvel com `publishToSite === true`, submissão aprovada (ou
cadastro interno) e que não esteja `vendido` nem `locado`. `em_negociacao`
continua anunciado.

Depois disso, o imóvel só entra se passar nas regras do portal. Cada regra que
ele não cumpre vira um motivo no relatório:

| Regra do portal | Campo do CRM |
|---|---|
| CEP em todo anúncio | `cep` do imóvel, ou tabela por bairro (abaixo) |
| Mínimo de 5 fotos, só JPG | `media[]` |
| Título de 10 a 100 caracteres | `titulo` (acima de 100 é cortado em palavra inteira) |
| Descrição de 50 a 3.000 caracteres | `descricao` (acima de 3.000 é cortada) |
| Casa, obra e apartamento: quartos, banheiros e área útil | `quartos`, `banheiros`, `areaConstr` |
| Terreno: área total | `areaTerreno` |
| Chácara: quartos, banheiros e área total | `quartos`, `banheiros`, `areaTerreno` |
| Preço inteiro conforme a finalidade | `precoVenda` / `precoLocacao` |
| Código único | `codigo` (vira o `ListingID`) |

A regra das 5 fotos está na doc como "todos os anúncios devem conter no mínimo
5 imagens", sem dizer o que acontece com quem tem menos. O padrão aqui é
respeitar; `--fotos-minimas N` no `configurar` afrouxa, por conta e risco.

**Nada é inventado para o imóvel passar.** Sem banheiros no cadastro, a casa
fica de fora e aparece no relatório — não entra com "1 banheiro" presumido.

### Situação em 16/11/2026

251 publicados, 236 candidatos. Só com a tabela de CEP que vem no código entram
**13**. Definindo o CEP do Riviera de Santa Cristina XIII entram **90**; com todos
os bairros resolvidos, **103**. O resto é ficha incompleta: 88 terrenos com menos
de 5 fotos, 22 casas sem área construída, 18 sem banheiros, 29 sem descrição.

## CEP: por que é uma tabela

O cadastro não tem campo de CEP, e o portal exige um em cada anúncio. Além
disso, **estas cidades não têm mais CEP único**: os Correios recodificaram por
rua, e o antigo `18720-000` de Paranapanema não existe mais na base (conferido
no ViaCEP em 16/11/2026).

Ordem de resolução:

1. campo `cep` do próprio imóvel, se existir;
2. `cepPorBairro` em `feed_portais/config`, gravado com `feedPortaisAdmin.js cep`;
3. `CEP_PADRAO` em `feedPortaisCore.js` — só os dez bairros cujo nome no cadastro
   bate exatamente com o nome nos Correios.

Sem CEP, o imóvel fica de fora e o diagnóstico lista o bairro.

O bairro que mais pesa não bate por nome: no cadastro é "Riviera de Santa
Cristina XIII"; nos Correios é "Terras de Santa Cristina XIII Setor Marina"
(`18727-2xx`) ou "Setor Iate" (`18727-0xx`). Escolher exige conhecer a região.

O portal pode exibir o nome de bairro que ele associa ao CEP, e não o que vai
no XML. Vale conferir um anúncio publicado depois da primeira carga.

## Endereço

Segue a decisão de 04/08/2026 da API de parceiros: **rua e número nunca saem**.
O anúncio leva cidade, bairro, o CEP representativo do bairro e a coordenada
arredondada a três casas (~110 m), com `displayAddress="Neighborhood"`, que
manda o portal mostrar só o bairro. O campo `endereco` nem é pedido ao banco: a
function usa `select()` com a lista `CAMPOS_LIDOS`, e um teste falha se algum
campo do proprietário entrar nela.

A doc avisa que número e complemento "em breve" serão obrigatórios para alguns
tipos de imóvel. Se isso entrar em vigor, a decisão precisa ser revista.

## Mapeamentos

| CRM | Portal |
|---|---|
| `casa` / `obra` com recurso `condominio` | `Residential / Condo` (Casa de Condomínio) |
| `casa` / `obra` sem ele | `Residential / Home` |
| `terreno` | `Residential / Land Lot` |
| `chacara` | `Residential / Agricultural` (filtro dos dois portais; `Farm Ranch` só existe no VivaReal) |
| `apartamento` | `Residential / Apartment` |
| `comercial` | `Commercial / Building` |
| `venda` / `locacao` / `ambos` | `For Sale` / `For Rent` / `Sale/Rent` |

Recursos com equivalente na tabela oficial viram `<Feature>`: piscina, churrasqueira,
portaria 24h, mobiliado, vista da represa (`Lake View`), wi-fi, energia
fotovoltaica, piscina aquecida, pomar, pet friendly, boiler, quadra, poço e campo
de futebol. **Píer, rampa e fire pit não têm equivalente** e ficam só na descrição.

Fotos do Drive saem como `lh3.googleusercontent.com/d/{id}=w1600-rj` — o `-rj`
pede JPEG ao CDN. Fotos do Storage saem com a `downloadUrl`, se forem JPG. No
máximo 50 por anúncio (teto nosso; a doc não dá um). O primeiro link do YouTube
em `videoLinks` vira o vídeo do anúncio.

## Controles

`feed_portais/config`, gravado pelo `feedPortaisAdmin.js configurar`:

| Opção | Efeito |
|---|---|
| `--modo todos` (padrão) | Entram todos os candidatos, menos os que tiverem `publishToPortais: false` no imóvel |
| `--modo marcados` | Só entram os que tiverem `publishToPortais: true` |
| `--limite N` | No máximo N anúncios, os de atualização mais recente. `0` tira o limite |
| `--destaque` | `PublicationType` de todos. Um imóvel com `portaisDestaque` usa o dele |
| `--ativo nao` | A URL passa a responder 503 |

Mudança de configuração vale na leitura seguinte: a function relê a config a
cada requisição. Só a lista de imóveis fica em cache (15 min), então marcar ou
editar um imóvel pode levar esse tempo para aparecer no XML.

### Marcar imóveis (modo `marcados`)

```
node feedPortaisAdmin.js marcar I08NI A05MI
node feedPortaisAdmin.js desmarcar I08NI
node feedPortaisAdmin.js marcados
node feedPortaisAdmin.js marcar --aptos
```

`marcar` grava só `publishToPortais: true` no imóvel e avisa na hora se ele
ainda não passa nas regras do portal, com o motivo. `marcar --aptos` lista todos
os que passam e ainda não têm marca; só grava com `--sim`. `diagnostico --lista`
mostra os códigos dos aptos à espera.

### No CRM (desde a v5.323, 17/11/2026)

O formulário do imóvel tem o campo **CEP** (em "Endereço e localização") e a
caixa **"Anunciar nos portais"** (em "Características"), que gravam `cep` e
`publishToPortais`. A ficha do imóvel marcado mostra o selo "📣 Portais" e, se
ele ainda não cumpre as regras, a lista do que falta.

- O captador não vê a caixa, e o Worker recusa a alteração se ele tentar
  (`publishToPortais` entrou nos campos travados, junto de `publishToSite`).
- O parceiro não recebe o `cep` do imóvel — vai junto com o endereço.
- O aviso de pendências do app (`_pendenciasPortais`, no `index.html`) repete as
  regras de `feedPortaisCore.js`. **Regra que mudar aqui tem de mudar lá**; o
  `testes-logica.js` compara os dois em 23 casos e falha se divergirem.
- O app não confere o CEP: sem `cep` no imóvel vale a tabela por bairro, que só
  o servidor conhece. `feedPortaisAdmin.js marcados` e o `/relatorio` dizem a verdade.

`portaisDestaque` (destaque por imóvel) continua sem tela.

**Limite contratado.** O plano do Canal Pro tem uma grade de anúncios; passando
dela, o portal inativa anúncios por conta própria. Use `--limite` com o número
do contrato para escolher quem fica.

## Como o portal trata o XML

- Lê a cada 12 horas. Mudança no CRM leva até meio dia para aparecer.
- Anúncio criado por XML não pode ser editado à mão no Canal Pro.
- Anúncio criado à mão no Canal Pro com o mesmo código dá erro de duplicidade.
- A doc **não diz** que um anúncio some do portal quando some do XML; diz que a
  inativação segue a grade contratada. Conferir na primeira vez que um imóvel
  for vendido.
- A URL de uma foto é a identidade dela: trocar a foto exige URL nova. Fotos do
  Drive e do Storage já se comportam assim.

## Segurança

- A URL é o segredo — o robô do portal não manda cabeçalho. O Firestore guarda
  só o sha256 do token, em `feed_portais_tokens/`.
- Token errado, revogado ou malformado responde **404**, igual a rota que não
  existe. Token fora do formato nem consulta o banco.
- `Cache-Control: no-store` e `X-Robots-Tag: noindex`.
- `/relatorio/{token}` usa o mesmo token e traz só códigos de imóvel e motivos.
- Vazou a URL: `node feedPortaisAdmin.js revogar <id>` e `criar-url` de novo.

## Deploy

Igual às outras functions: push na `main` que toque o `index.js` dispara o
workflow. `feedPortais` é Gen2 e sobe privada; depois do primeiro deploy:

```
gcloud run services add-iam-policy-binding feedportais --region=us-central1 --member=allUsers --role=roles/run.invoker --project=seuimovelnarepresa
```

Não cria trigger nem agendamento. Custo: uma leitura do Firestore por imóvel
publicado a cada geração (cache de 15 minutos na instância) mais uma leitura da
config por requisição — duas gerações por dia no uso normal.

## Testes

```
node testeFeedPortais.js
node testeFeedPortaisHttp.js
```

O XSD oficial (`http://xml.vivareal.com/vrsync.xsd`) responde 403 a download,
então não há validação de schema aqui. O que existe: XML bem-formado conferido
com o parser do .NET sobre os dados reais, e o validador do próprio portal em
<https://developers.grupozap.com/feeds/xml_validator/>.
