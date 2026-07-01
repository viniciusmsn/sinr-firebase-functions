# SINR — Cloud Functions (deploy via GitHub Actions)

Cloud Functions do Firebase que sincronizam o app CRM com o site novo (Astro estático na Cloudflare Pages). Deploy **100% automático** via GitHub Actions — você não precisa mexer com `firebase login`, terminal ou service account no disco local.

## O que tem aqui

### `triggerSiteRebuild`

**Trigger:** `onWrite` em `properties/{propId}`.

**Ação:** Dispara `POST` no Deploy Hook da Cloudflare Pages quando um imóvel muda em algum campo relevante (`publishToSite`, `wpPostId`, `dealStatus`, `submissionStatus`, `titulo`, `codigo`, `precoVenda`, `precoLocacao`, `descricao`, `bairro`, `cidade`, `recursos`, `media`, `lat`, `lng`). Debounce de 2 minutos pra evitar múltiplos rebuilds em edições sequenciais.

### `flushPendingRebuilds`

Cron a cada 5 minutos. Varre rebuilds pendentes (que ficaram bloqueados pelo debounce) e dispara.

## Como funciona o deploy

```
Você edita index.js → git push
              ↓
GitHub Actions dispara automaticamente
              ↓
Runner Linux instala Node + Firebase CLI
              ↓
Deploya usando Service Account (secret)
              ↓
Cloud Functions atualizadas ✓
```

**Você nunca instala firebase-tools localmente.** Nunca roda `firebase login`. Nunca lida com credenciais no disco.

## Setup inicial (uma vez)

### 1. Cria o repo no GitHub

- Vai em https://github.com/new
- Nome: `sinr-firebase-functions` (ou o que preferir)
- Privado ✓
- **Não** inicializa com README (vamos subir tudo daqui)

### 2. Sobe os arquivos

Duas opções:

**Opção A — Interface web do GitHub (sem terminal):**
1. Na página do repo recém-criado, clica em **"uploading an existing file"**
2. Arrasta TODOS os arquivos desta pasta (incluindo `.github/` e `.gitignore`)
3. Commit: "Setup inicial"

**Opção B — GitHub Desktop (GUI):**
1. Baixa https://desktop.github.com
2. File → Add local repository → aponta pra esta pasta
3. Publish repository (marca "Keep code private")

### 3. Gera Service Account no Firebase

1. Abre https://console.firebase.google.com/project/seuimovelnarepresa/settings/serviceaccounts/adminsdk
2. Clica em **"Generate new private key"** → confirma → baixa o JSON
3. **Abre o JSON num editor** (Notepad, VS Code) e **copia TODO o conteúdo** (Ctrl+A, Ctrl+C)
4. **NÃO commita esse arquivo no git** (`.gitignore` já protege)

### 4. Cria o Deploy Hook na Cloudflare Pages

1. Abre https://dash.cloudflare.com (sua conta) → Workers & Pages → seu projeto do site novo
2. Settings → Builds & deployments → Deploy hooks → **"Add deploy hook"**
3. Nome: `firestore-rebuild`
4. Branch: `main` (ou a branch de produção do site)
5. Copia a URL gerada (algo tipo `https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/<UUID>`)

Se o projeto Astro ainda não está na Cloudflare, esse passo pode ser feito depois — o workflow vai deployar as functions mesmo assim, apenas não vão disparar nada até você configurar.

### 5. Configura os 2 secrets no GitHub

1. No repo → Settings → Secrets and variables → Actions → **"New repository secret"**
2. Cria os 2 secrets:

   **`FIREBASE_SERVICE_ACCOUNT`**
   - Valor: **cole o JSON inteiro** que você copiou no passo 3
   - Não altera nada, cola exatamente igual

   **`DEPLOY_HOOK_URL`**
   - Valor: a URL do Deploy Hook do passo 4

3. Clica **"Add secret"** pra cada um

### 6. Dispara o primeiro deploy

- No repo → aba **Actions**
- Vai listar o workflow **"Deploy Cloud Functions"**
- Clica → **"Run workflow"** → seleciona `main` → **"Run workflow"** (verde)
- ~3-5 min depois, aparece ✅ verde no workflow

**Sucesso quando aparecer nos logs do runner:**
```
✔  functions[triggerSiteRebuild(us-central1)]: Successful create operation.
✔  functions[flushPendingRebuilds(us-central1)]: Successful create operation.
✔  Deploy complete!
```

## Deploys futuros

Depois do setup, cada `git push` na `main` que tocar em `index.js`, `package.json` ou o próprio workflow **deploya automaticamente**.

Se quiser deploy manual (sem push), vai em Actions → **"Run workflow"**.

Se quiser trocar o Deploy Hook URL (mudou de branch, recriou o hook, etc):
1. Vai em Settings → Secrets → edita `DEPLOY_HOOK_URL`
2. Actions → Run workflow (pra redeployar com o novo valor)

## Como testar depois do primeiro deploy

### Teste 1 — publicar um imóvel

1. Abre o app CRM
2. Abre um imóvel → clica **"📤 Publicar no site"**
3. Ve no Firestore Console: `publishToSite: true` deve aparecer no documento
4. Ve nos logs do Firebase Functions: https://console.firebase.google.com/project/seuimovelnarepresa/functions/logs
5. Deve aparecer "Deploy hook acionado, status: 200"
6. ~1-2 min depois, o imóvel aparece em `seuimovelnarepresa.com.br/imoveis`

### Teste 2 — despublicar

1. No mesmo imóvel, clica **"⛔ Despublicar do site"**
2. `publishToSite: false`, `wpPostId: null`
3. Próximo rebuild → imóvel some da listagem

## Custos

- **Cloud Functions (Spark plan):** 2M invocações/mês grátis. Uso real: ~9k/mês. **Grátis.**
- **Cloud Scheduler:** 3 jobs/mês grátis. Uso: 1. **Grátis.**
- **Cloudflare Pages builds:** 500/mês grátis. Uso com debounce 2min: ~100/mês. **Grátis.**
- **GitHub Actions:** 2.000 min/mês grátis pra repos privados. Deploy leva ~3 min. Suficiente pra 600 deploys/mês.

## Estrutura de arquivos

```
firebase-functions/
├── index.js                                  # código das 2 functions
├── package.json                              # deps
├── firebase.json                             # config do CLI
├── .firebaserc                               # → projeto seuimovelnarepresa
├── .gitignore                                # ignora node_modules, .env, service-account.json
├── .github/
│   └── workflows/
│       └── deploy-functions.yml             # workflow de deploy
└── README.md                                 # este arquivo
```

## Troubleshooting

### Workflow fica vermelho, logs mostram "invalid_grant"
Service account expirou ou foi recriada. Gera nova em Firebase Console → cola de novo em `FIREBASE_SERVICE_ACCOUNT`.

### Workflow OK, mas a function loga "DEPLOY_HOOK_URL nao configurado"
O secret `DEPLOY_HOOK_URL` está vazio ou não foi setado. Verifica em Settings → Secrets.

### Function dispara mas Cloudflare não faz build novo
Confirma no Cloudflare Pages → Deployments se novo build aparece. Se aparece mas falha, o erro é no build do Astro (não relacionado à function). Se nem aparece, o Deploy Hook URL está errado.

### Precisa alterar código da function e redeploy
Edita `index.js` no GitHub (botão de lápis na interface web) → commit direto na main → deploy dispara sozinho.
