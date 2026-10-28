# propostaPublica — runbook

Ponte de servidor para os links `?aceite=`, `?compra=` e `?dossie=`. O token
deixa de ser uma senha que abre a coleção inteira e vira uma chave que abre
**um** documento, com campos filtrados na ida e na volta.

---

## Deploy

```bash
cd C:\Users\vinic\OneDrive\Documentos\APPSINR\sinr-firebase-functions\firebase-functions
node testePropostaPublica.js          # 20 testes, roda sem GCP
firebase deploy --only functions:propostaPublica --project seuimovelnarepresa
```

A URL sai no fim do deploy, no formato:

```
https://us-central1-seuimovelnarepresa.cloudfunctions.net
```

Cole **a base** (sem `/propostaPublica`) no `config.js`:

```js
cloudFunctions: { base: "https://us-central1-seuimovelnarepresa.cloudfunctions.net" },
```

Depois suba o `config.js` **com o cache-bust bumpado** — o nginx do Cloudez
cacheia `.js` por dez anos.

> `base` vazio faz o app cair no modo antigo, lendo direto do Firestore. É a
> válvula de escape se a function ficar fora do ar: dá para esvaziar o campo e
> subir só o `config.js`, sem tocar no `index.html`.

---

## Contrato

`POST /propostaPublica`

```json
{ "acao": "ler" | "gravar",
  "tipo": "aceite" | "compra" | "dossie",
  "token": "…",
  "patch": { } }
```

Resposta: `{ "ok": true, "proposta": {…} }` ou `{ "ok": false, "erro": "…" }`.

O cliente distingue os dois casos de falha, e a distinção importa:

- **Erro de rede, CORS ou função inexistente** → `SEM_CF`, cai no modo direto.
- **A função respondeu com `erro`** → é verdade sobre o link. Não cai para o
  modo direto, senão um token revogado voltaria a funcionar pelo caminho antigo.

---

## O que nunca sai, em nenhum escopo

`commissionPayment` · `history` · `revisaoDocumental` · `buyerToken` ·
`acceptanceToken` · `signatarioTokens` · `sentBy` · `sentByName` ·
`assignedTo` · `updatedBy` · `driveFolderId`

Ou seja: o dinheiro da imobiliária e as notas internas de negociação não
chegam às partes. A nota *"o comprador ofereceu 250 mil, mas o vendedor não
aceitou"* é exatamente o tipo de coisa que estava saindo antes.

## O que cada escopo enxerga

| | `aceite` | `compra` | `dossie` |
|---|---|---|---|
| Dados do vendedor | ✅ | ❌ | ✅ |
| Dados do comprador | ❌ | ✅ | ✅ |
| Documentos dos sócios | só os próprios | ❌ | ✅ |
| Token dos outros sócios | ❌ | ❌ | ❌ |
| Checklist do dossiê | ✅ | ❌ | ✅ |

O `dossie` mostra os dois lados porque foi a decisão de 27/08 — "tudo do
negócio". Os outros dois escopos são estanques.

Um sócio recebe o próprio registro completo e, dos demais, apenas
`nome`, `papel`, `signedAt` e um booleano `preenchido`. A tela consegue dizer
"o Rodrigo já preencheu" sem receber o CPF do Rodrigo.

### O link mestre é a exceção — e precisa ser

Entrar pelo `acceptanceToken` (o link original do lado vendedor, anterior aos
sócios) devolve a **lista inteira de signatários, com tokens**, e permite gravar
essa lista.

Não é descuido. Quando a negociação tem sócios e alguém abre o link mestre, o
app pergunta *"quem está assinando?"* e segue com o token da pessoa escolhida —
é a correção da v5.256, que existia porque antes o sócio preenchia tudo e
continuava constando como pendente. Reduzir a resposta aqui quebraria esse
caminho.

E não há ganho em esconder: quem tem o link mestre já podia agir pela
negociação inteira. A trava que importa continua valendo — **um sócio não
reescreve o registro do outro**, verificado item a item.

## O que cada escopo pode gravar

| Escopo | Campos |
|---|---|
| `aceite` | `sellerInfo`, `sellerDocs`, `acceptanceStage`, `sellerSignedAt`, `docsUploadedAt`, `status`, `sellerPaidDeclaredAt`, `signatarios` |
| `compra` | `buyerInfo`, `buyerDocs`, `buyerStage`, `buyerSignedAt`, `docsUploadedAt`, `status`, `buyerPaidDeclaredAt` |
| `dossie` | nada — consulta apenas |

Campo fora da lista devolve **400 com o nome do campo**, em vez de ser ignorado
em silêncio. Erro silencioso aqui viraria "preenchi e não salvou".

`signatarios` tem regra extra: só quem entrou com token de signatário mexe
nele, e a validação compara item a item contra o que está gravado. Alterar o
registro de outro sócio, remover alguém da lista ou trocar a ordem para se
passar pelo vizinho — os três são recusados. Há teste para cada um.

---

## Testes

`node testePropostaPublica.js` — 20 testes, sem GCP e sem emulador. Extrai
`projetar` e `validarPatch` do arquivo por texto, porque eles não são
exportados (e não devem ser: só a function é contrato público).

Cobrem vazamento por escopo, separação entre as partes, o caso do dossiê que
precisa dos anexos mas não dos tokens, e as quatro tentativas de um sócio
escrever no registro do outro.

---

## Ordem de corte, e por que ela importa

1. **Aplicar `firestore.rules.CORRIGIDO`.** Fecha o acesso de quem não tem
   login nenhum. É o buraco grande, e independe da function.
2. **Subir a function** e preencher `cloudFunctions.base` no `config.js`.
3. **Testar os três links** numa janela anônima, um de cada tipo.
4. **Só então** endurecer a regra de `proposals` para exigir papel:

```js
match /proposals/{id} {
  allow read, write: if temPapel(['admin','gerente','documental','corretor']);
}
```

O passo 4 é o que tira o acesso do login anônimo. Fazer isso **antes** do
passo 3 derruba os links das partes.

⚠️ Só migrei o `?dossie=` (v5.271). `?aceite=` e `?compra=` ainda leem e
gravam direto. Enquanto eles não migrarem, o passo 4 não pode ser aplicado.

---

## Pendências

- Migrar `?aceite=` e `?compra=` para a function (16 pontos de escrita).
- `properties` segue com `get, list: if true` e carrega `submitterInfo` com
  CPF/RG de quem usa o `?cadastrar`. Mover para subcoleção privada.
- Upload de documentos continua indo direto para o Storage. As regras do
  Storage são outro arquivo e não foram revisadas nesta passagem.
