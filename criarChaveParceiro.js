/**
 * Gera uma chave de API para um parceiro e grava o HASH em api_keys/.
 *
 * Roda na SUA maquina, de dentro desta pasta:
 *
 *   node criarChaveParceiro.js "Imobiliaria X" https://www.imobiliariax.com.br
 *
 * A credencial e localizada sozinha: o script procura o JSON do adminsdk nesta
 * pasta e na pasta acima. Se voce tiver GOOGLE_APPLICATION_CREDENTIALS setado,
 * ele respeita essa variavel.
 *
 * A chave em texto aparece UMA UNICA VEZ no terminal. O Firestore guarda so o
 * sha256 — se perder, nao da pra recuperar: gera outra e desativa a antiga.
 *
 * Outros comandos:
 *   node criarChaveParceiro.js --listar
 *   node criarChaveParceiro.js --desativar <keyId>
 */

const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** Procura o JSON do service account nesta pasta e na de cima. */
function acharCredencial() {
  for (const dir of [__dirname, path.join(__dirname, '..')]) {
    let arquivos;
    try { arquivos = fs.readdirSync(dir); } catch (_) { continue; }
    const achado = arquivos.find((f) => /firebase-adminsdk.*\.json$/i.test(f));
    if (achado) return path.join(dir, achado);
  }
  return null;
}

try {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ projectId: 'seuimovelnarepresa' });
  } else {
    const cred = acharCredencial();
    if (!cred) {
      console.error('\nNao achei o JSON do service account.');
      console.error('Ele deve estar nesta pasta ou na de cima, com nome tipo');
      console.error('  seuimovelnarepresa-firebase-adminsdk-<algo>.json');
      console.error('Baixe um novo em: Firebase Console > Configuracoes do projeto >');
      console.error('Contas de servico > Gerar nova chave privada.\n');
      process.exit(1);
    }
    admin.initializeApp({
      projectId: 'seuimovelnarepresa',
      credential: admin.credential.cert(require(cred)),
    });
    console.log('credencial: ' + path.basename(cred));
  }
} catch (err) {
  console.error('Falha ao inicializar o Firebase: ' + err.message);
  process.exit(1);
}

const db = admin.firestore();

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

function slug(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

async function listar() {
  const snap = await db.collection('api_keys').get();
  if (snap.empty) { console.log('Nenhuma chave cadastrada.'); return; }
  console.log('\nid'.padEnd(30) + 'nome'.padEnd(28) + 'ativo   ultimoUso');
  console.log('-'.repeat(90));
  snap.forEach((d) => {
    const k = d.data();
    console.log(
      String(d.id).padEnd(30) +
      String(k.nome || '').padEnd(28) +
      String(k.ativo === true).padEnd(8) +
      String(k.ultimoUso || 'nunca')
    );
  });
  console.log('');
}

async function desativar(keyId) {
  const ref = db.collection('api_keys').doc(keyId);
  const snap = await ref.get();
  if (!snap.exists) { console.error('Chave nao encontrada: ' + keyId); process.exit(1); }
  await ref.set({ ativo: false, desativadoEm: new Date().toISOString() }, { merge: true });
  console.log('Chave ' + keyId + ' desativada.');
  console.log('Leva ate 5 min pra propagar (cache de chave nas instancias da function).');
}

async function criar(nome, origins) {
  // 32 bytes de entropia. O prefixo so ajuda a identificar a chave num log.
  const chave = 'sinr_' + crypto.randomBytes(32).toString('base64url');
  const keyId = slug(nome) + '-' + crypto.randomBytes(3).toString('hex');

  await db.collection('api_keys').doc(keyId).set({
    hash: sha256(chave),
    nome,
    ativo: true,
    origins,
    limitePorMinuto: 120,
    limiteDiario: 20000,
    criadoEm: new Date().toISOString(),
    ultimoUso: null,
    chamadasHoje: 0,
  });

  console.log('\n' + '='.repeat(72));
  console.log('CHAVE CRIADA — copie agora, ela nao aparece de novo');
  console.log('='.repeat(72));
  console.log('  parceiro : ' + nome);
  console.log('  keyId    : ' + keyId);
  console.log('  origens  : ' + (origins.length ? origins.join(', ') : '(nenhuma — so server-to-server)'));
  console.log('');
  console.log('  X-API-Key: ' + chave);
  console.log('='.repeat(72));
  console.log('\nMande por canal seguro. Nunca por e-mail comum ou WhatsApp.');
  console.log('Se as origens estiverem vazias, o parceiro so consegue chamar do');
  console.log('servidor dele — o navegador vai barrar por CORS.\n');
}

(async () => {
  const args = process.argv.slice(2);
  try {
    if (args[0] === '--listar') {
      await listar();
    } else if (args[0] === '--desativar') {
      if (!args[1]) { console.error('Uso: node criarChaveParceiro.js --desativar <keyId>'); process.exit(1); }
      await desativar(args[1]);
    } else if (args[0] && !args[0].startsWith('--')) {
      await criar(args[0], args.slice(1).filter((o) => /^https?:\/\//.test(o)));
    } else {
      console.log('Uso:');
      console.log('  node criarChaveParceiro.js "Imobiliaria X" https://www.imobiliariax.com.br');
      console.log('  node criarChaveParceiro.js --listar');
      console.log('  node criarChaveParceiro.js --desativar <keyId>');
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error('ERRO: ' + err.message);
    process.exit(1);
  }
})();
