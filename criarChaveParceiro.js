/**
 * Gera uma chave de API para um parceiro e grava o HASH em api_keys/.
 *
 * Roda na SUA maquina (o sandbox do Claude nao alcanca o GCP), com o
 * service account JSON que voce ja tem:
 *
 *   set GOOGLE_APPLICATION_CREDENTIALS=C:\...\seuimovelnarepresa-firebase-adminsdk-....json
 *   node criarChaveParceiro.js "Imobiliaria X" https://www.imobiliariax.com.br
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

admin.initializeApp({ projectId: 'seuimovelnarepresa' });
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
