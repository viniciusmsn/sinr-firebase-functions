/**
 * API publica de imoveis — somente leitura, para parceiros externos.
 *
 * ============================================================================
 * COMO PLUGAR NO index.js  (NAO reescreva o index.js inteiro — veja o README)
 * ============================================================================
 *   const admin = require('firebase-admin');
 *   admin.initializeApp();                 // <- ja existe no index.js
 *   ...
 *   // No FINAL do index.js, DEPOIS do admin.initializeApp():
 *   Object.assign(exports, require('./apiImoveis'));
 * ============================================================================
 *
 * Decisoes fechadas em 04/08/2026:
 *   1. Endereco exato NUNCA sai. Sem flag, sem excecao. A resposta traz
 *      bairro + cidade + lat/lng arredondado a 3 casas (~110 m).
 *   2. Catalogo materializado em api_catalog/: um trigger regenera, a API le
 *      esses docs e cacheia em memoria em vez de varrer properties.
 *   3. Fotos do Drive saem como estao, mesmo sem marca d'agua.
 *
 * Cloud Functions exportadas por este arquivo:
 *   apiImoveis              — HTTP, a API em si
 *   rebuildCatalogoImoveis  — trigger onWrite em properties/{propId}
 *   flushCatalogoImoveis    — cron de seguranca / primeira geracao
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');

const core = require('./apiImoveisCore');

// Se o index.js ja inicializou (caso normal), nao reinicializa.
if (!admin.apps.length) admin.initializeApp();

const REGIAO = 'us-central1';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

// Imoveis por documento do catalogo. 236 / 60 = 4 docs de ~200 KB,
// bem longe do teto de 1 MB por documento do Firestore.
const CHUNK_SIZE = 60;

const LIMIT_PADRAO = 50;
const LIMIT_TETO = 200;

// Cache em memoria da instancia. Enquanto valido, a API faz ZERO leituras.
const CACHE_CATALOGO_MS = 60 * 1000;
const CACHE_CHAVE_MS = 5 * 60 * 1000;

// Rate limit por chave (por instancia — ver nota no README).
const LIMITE_POR_MINUTO_PADRAO = 120;
const LIMITE_DIARIO_PADRAO = 20000;

// Intervalo minimo entre rebuilds disparados por trigger.
const REBUILD_DEBOUNCE_MS = 30 * 1000;

// Campos de properties que, mudando, invalidam o catalogo.
const CAMPOS_RELEVANTES = [
  'publishToSite', 'submissionStatus', 'dealStatus',
  'codigo', 'titulo', 'descricao', 'categoria', 'finalidade',
  'precoVenda', 'precoLocacao', 'bairro', 'cidade', 'lat', 'lng',
  'quartos', 'suites', 'banheiros', 'vagas', 'areaTerreno', 'areaConstr',
  'recursos', 'aptoFinanciamento', 'media',
];

class ErroApi extends Error {
  constructor(status, codigo, mensagem) {
    super(mensagem);
    this.status = status;
    this.codigo = codigo;
  }
}

// ---------------------------------------------------------------------------
// Catalogo materializado — escrita
// ---------------------------------------------------------------------------

function refMeta() { return admin.firestore().doc('api_catalog/meta'); }
function refChunk(i) { return admin.firestore().doc('api_catalog/chunk_' + i); }

async function reconstruirCatalogo(motivo) {
  const db = admin.firestore();

  // Le so os publicados — nao a colecao inteira.
  const snap = await db.collection('properties').where('publishToSite', '==', true).get();

  const itens = [];
  snap.forEach((doc) => {
    const pub = core.paraPublico(doc.data());
    if (pub) itens.push(pub);
  });

  // Mais recentes primeiro — ordem padrao da listagem.
  itens.sort((a, b) => String(b.atualizadoEm || '').localeCompare(String(a.atualizadoEm || '')));

  const chunks = [];
  for (let i = 0; i < itens.length; i += CHUNK_SIZE) chunks.push(itens.slice(i, i + CHUNK_SIZE));
  if (chunks.length === 0) chunks.push([]);

  // Guarda contra o teto de 1 MB por documento.
  chunks.forEach((c, i) => {
    const bytes = Buffer.byteLength(JSON.stringify(c), 'utf8');
    if (bytes > 900 * 1024) {
      logger.error('Chunk do catalogo perto do teto de 1 MB — reduza CHUNK_SIZE', { chunk: i, bytes });
    }
  });

  const metaSnap = await refMeta().get();
  const chunksAntes = metaSnap.exists ? (metaSnap.data().chunks || 0) : 0;
  const versao = String(Date.now());

  const batch = db.batch();
  chunks.forEach((c, i) => batch.set(refChunk(i), { versao, itens: c }));
  // Remove chunks que sobraram de uma versao maior.
  for (let i = chunks.length; i < chunksAntes; i++) batch.delete(refChunk(i));
  batch.set(refMeta(), {
    versao,
    total: itens.length,
    chunks: chunks.length,
    geradoEm: new Date().toISOString(),
    ultimoRebuildAt: Date.now(),
    sujo: false,
    motivo: String(motivo || '').slice(0, 300),
  }, { merge: true });

  await batch.commit();
  logger.info('Catalogo reconstruido', { total: itens.length, chunks: chunks.length, motivo });
  return { total: itens.length, chunks: chunks.length, versao };
}

/**
 * Reconstroi respeitando um debounce. Se veio cedo demais, marca `sujo` e
 * deixa o cron flushCatalogoImoveis pegar. Mesmo padrao do triggerSiteRebuild.
 */
async function reconstruirComDebounce(motivo) {
  const db = admin.firestore();
  const agora = Date.now();

  const podeAgora = await db.runTransaction(async (tx) => {
    const snap = await tx.get(refMeta());
    const data = snap.exists ? snap.data() : {};
    if (agora - (data.ultimoRebuildAt || 0) < REBUILD_DEBOUNCE_MS) {
      tx.set(refMeta(), { sujo: true, motivoPendente: String(motivo).slice(0, 300) }, { merge: true });
      return false;
    }
    tx.set(refMeta(), { ultimoRebuildAt: agora }, { merge: true });
    return true;
  });

  if (podeAgora) await reconstruirCatalogo(motivo);
  else logger.info('Rebuild do catalogo debounciado', { motivo });
}

// ---------------------------------------------------------------------------
// Catalogo materializado — leitura (com cache de instancia)
// ---------------------------------------------------------------------------

let _cache = { versao: null, itens: null, geradoEm: null, checadoEm: 0 };

async function lerCatalogo() {
  const agora = Date.now();
  if (_cache.itens && (agora - _cache.checadoEm) < CACHE_CATALOGO_MS) return _cache;

  const db = admin.firestore();
  const metaSnap = await refMeta().get();          // 1 leitura
  if (!metaSnap.exists) {
    throw new ErroApi(503, 'catalogo_indisponivel',
      'O catalogo ainda nao foi gerado. Ele se popula sozinho em ate 15 minutos apos o deploy.');
  }
  const meta = metaSnap.data();

  // Versao igual = o que esta em memoria continua valido; nao le os chunks.
  if (_cache.itens && _cache.versao === meta.versao) {
    _cache.checadoEm = agora;
    return _cache;
  }

  const refs = [];
  for (let i = 0; i < (meta.chunks || 0); i++) refs.push(refChunk(i));
  const docs = refs.length ? await db.getAll.apply(db, refs) : [];

  const itens = [];
  docs.forEach((d) => { if (d.exists) itens.push.apply(itens, d.data().itens || []); });

  _cache = { versao: meta.versao, itens, geradoEm: meta.geradoEm || null, checadoEm: agora };
  return _cache;
}

// ---------------------------------------------------------------------------
// Autenticacao por chave
// ---------------------------------------------------------------------------

const _cacheChaves = new Map(); // hash -> { chave, expiraEm }

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

async function autenticar(req) {
  const bruta = req.get('X-API-Key') || '';
  if (!bruta) throw new ErroApi(401, 'chave_ausente', 'Envie a chave no header X-API-Key.');

  const hash = sha256(bruta);
  const agora = Date.now();

  const cached = _cacheChaves.get(hash);
  if (cached && cached.expiraEm > agora) {
    if (!cached.chave) throw new ErroApi(401, 'chave_invalida', 'Chave invalida ou desativada.');
    return cached.chave;
  }

  const snap = await admin.firestore()
    .collection('api_keys').where('hash', '==', hash).limit(1).get();

  const doc = snap.empty ? null : snap.docs[0];
  const dados = doc && doc.data();
  const valida = !!(dados && dados.ativo === true);

  const chave = valida ? {
    id: doc.id,
    nome: dados.nome || doc.id,
    origins: Array.isArray(dados.origins) ? dados.origins : [],
    limiteDiario: core.paraInteiro(dados.limiteDiario) || LIMITE_DIARIO_PADRAO,
    limitePorMinuto: core.paraInteiro(dados.limitePorMinuto) || LIMITE_POR_MINUTO_PADRAO,
  } : null;

  // Cacheia tambem o resultado negativo (janela curta), pra que uma enxurrada
  // de chaves invalidas nao vire uma enxurrada de leituras no Firestore.
  _cacheChaves.set(hash, { chave, expiraEm: agora + (valida ? CACHE_CHAVE_MS : 60 * 1000) });

  if (!chave) throw new ErroApi(401, 'chave_invalida', 'Chave invalida ou desativada.');
  return chave;
}

// ---------------------------------------------------------------------------
// Rate limit e contabilizacao de uso
// ---------------------------------------------------------------------------

const _uso = new Map(); // keyId -> contadores da instancia

function verificarRateLimit(chave) {
  const agora = Date.now();
  const minutoTs = Math.floor(agora / 60000);
  const dia = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

  let u = _uso.get(chave.id);
  if (!u) {
    u = { minutoTs, minutoCount: 0, dia, diaCount: 0, naoGravado: 0, gravadoEm: 0 };
    _uso.set(chave.id, u);
  }
  if (u.minutoTs !== minutoTs) { u.minutoTs = minutoTs; u.minutoCount = 0; }
  if (u.dia !== dia) { u.dia = dia; u.diaCount = 0; }

  u.minutoCount++;
  u.diaCount++;
  u.naoGravado++;

  if (u.minutoCount > chave.limitePorMinuto) {
    throw new ErroApi(429, 'rate_limit',
      'Limite de ' + chave.limitePorMinuto + ' requisicoes por minuto atingido.');
  }
  if (u.diaCount > chave.limiteDiario) {
    throw new ErroApi(429, 'cota_diaria',
      'Cota diaria de ' + chave.limiteDiario + ' requisicoes atingida.');
  }
  return u;
}

/**
 * Grava o uso no Firestore no maximo 1x a cada 5 min por chave/instancia.
 * Gravar a cada request custaria mais que as leituras que o catalogo economiza.
 */
async function talvezGravarUso(chave, u) {
  const agora = Date.now();
  if (agora - u.gravadoEm < 5 * 60 * 1000) return;
  const delta = u.naoGravado;
  if (delta <= 0) return;
  u.naoGravado = 0;
  u.gravadoEm = agora;
  try {
    await admin.firestore().collection('api_keys').doc(chave.id).set({
      ultimoUso: new Date().toISOString(),
      chamadasHoje: admin.firestore.FieldValue.increment(delta),
      chamadasHojeDia: u.dia,
    }, { merge: true });
  } catch (err) {
    logger.warn('Falha ao gravar uso da chave', { keyId: chave.id, err: err.message });
  }
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

async function rotaImoveis(q) {
  const cat = await lerCatalogo();
  const filtrados = core.ordenar(core.aplicarFiltros(cat.itens, q), q.ordenar);

  const limit = Math.min(Math.max(core.paraInteiro(q.limit) || LIMIT_PADRAO, 1), LIMIT_TETO);
  const page = Math.max(core.paraInteiro(q.page) || 1, 1);
  const inicio = (page - 1) * limit;

  return {
    data: filtrados.slice(inicio, inicio + limit).map(core.limpar),
    meta: {
      page,
      limit,
      total: filtrados.length,
      totalPaginas: Math.max(Math.ceil(filtrados.length / limit), 1),
      catalogoGeradoEm: cat.geradoEm,
    },
  };
}

async function rotaImovel(codigo) {
  const cat = await lerCatalogo();
  const alvo = core.semAcento(codigo);
  const it = cat.itens.find((x) => core.semAcento(x.codigo) === alvo);
  if (!it) throw new ErroApi(404, 'nao_encontrado', 'Nenhum imovel publicado com codigo ' + codigo + '.');
  return { data: core.limpar(it), meta: { catalogoGeradoEm: cat.geradoEm } };
}

async function rotaBairros() {
  const cat = await lerCatalogo();
  const mapa = new Map();
  cat.itens.forEach((it) => {
    if (!it.bairro) return;
    if (it.dealStatus === 'vendido' || it.dealStatus === 'locado') return;
    const k = it._cidadeNorm + '|' + it._bairroNorm;
    const atual = mapa.get(k);
    if (atual) atual.totalImoveis++;
    else mapa.set(k, { bairro: it.bairro, cidade: it.cidade, totalImoveis: 1 });
  });
  const data = Array.from(mapa.values())
    .sort((a, b) => String(a.bairro).localeCompare(String(b.bairro), 'pt-BR'));
  return { data, meta: { total: data.length, catalogoGeradoEm: cat.geradoEm } };
}

// ---------------------------------------------------------------------------
// Cloud Function HTTP
// ---------------------------------------------------------------------------

function aplicarCors(req, res, chave) {
  const origin = req.get('Origin');
  if (!origin) return; // server-to-server: CORS nao se aplica
  res.set('Vary', 'Origin');
  // Restrito as origens cadastradas na chave — nunca '*'.
  if (chave && chave.origins.indexOf(origin) !== -1) {
    res.set('Access-Control-Allow-Origin', origin);
  }
}

exports.apiImoveis = onRequest(
  { region: REGIAO, cors: false, maxInstances: 10 },
  async (req, res) => {
    // Preflight: o navegador nao manda X-API-Key no OPTIONS, entao nao da pra
    // autenticar aqui. Liberar o preflight nao expoe dado nenhum — o GET real
    // continua exigindo chave valida, e o Allow-Origin dele so sai se a origem
    // estiver cadastrada na chave.
    if (req.method === 'OPTIONS') {
      const origin = req.get('Origin');
      if (origin) {
        res.set('Access-Control-Allow-Origin', origin);
        res.set('Vary', 'Origin');
      }
      res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'X-API-Key, Content-Type');
      res.set('Access-Control-Max-Age', '3600');
      res.status(204).send('');
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).json({ error: { codigo: 'metodo_nao_permitido', mensagem: 'Somente GET.' } });
      return;
    }

    let chave = null;
    try {
      chave = await autenticar(req);
      const uso = verificarRateLimit(chave);

      // Normaliza o path: funciona com e sem o prefixo do nome da function.
      let caminho = String(req.path || '/').replace(/^\/apiImoveis/, '');
      caminho = caminho.replace(/\/+$/, '') || '/';

      let corpo;
      const mDetalhe = caminho.match(/^\/v1\/imoveis\/(.+)$/);
      if (caminho === '/v1/imoveis') {
        corpo = await rotaImoveis(req.query || {});
      } else if (mDetalhe) {
        corpo = await rotaImovel(decodeURIComponent(mDetalhe[1]));
      } else if (caminho === '/v1/bairros') {
        corpo = await rotaBairros();
      } else if (caminho === '/v1/status') {
        const cat = await lerCatalogo();
        corpo = {
          data: {
            ok: true,
            totalImoveis: cat.itens.length,
            catalogoGeradoEm: cat.geradoEm,
            parceiro: chave.nome,
          },
        };
      } else {
        throw new ErroApi(404, 'rota_desconhecida',
          'Rotas: GET /v1/imoveis, GET /v1/imoveis/{codigo}, GET /v1/bairros, GET /v1/status');
      }

      aplicarCors(req, res, chave);
      res.set('Cache-Control', 'public, max-age=300');
      res.status(200).json(corpo);

      await talvezGravarUso(chave, uso);
    } catch (err) {
      aplicarCors(req, res, chave);
      res.set('Cache-Control', 'no-store');
      if (err instanceof ErroApi) {
        res.status(err.status).json({ error: { codigo: err.codigo, mensagem: err.message } });
      } else {
        logger.error('Erro nao tratado na apiImoveis', { err: err.message, stack: err.stack });
        res.status(500).json({ error: { codigo: 'erro_interno', mensagem: 'Erro interno.' } });
      }
    }
  }
);

// ---------------------------------------------------------------------------
// Trigger + cron do catalogo
// ---------------------------------------------------------------------------

function campoMudou(antes, depois, campo) {
  return JSON.stringify(antes ? antes[campo] : undefined) !==
         JSON.stringify(depois ? depois[campo] : undefined);
}

exports.rebuildCatalogoImoveis = onDocumentWritten(
  { document: 'properties/{propId}', region: REGIAO },
  async (event) => {
    const antes = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
    const depois = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;

    const eraPublicado = !!(antes && antes.publishToSite === true);
    const ehPublicado = !!(depois && depois.publishToSite === true);

    let precisa;
    let motivo;
    if (!depois) {
      precisa = eraPublicado;
      motivo = 'delete:' + event.params.propId;
    } else if (!antes) {
      precisa = ehPublicado;
      motivo = 'create:' + event.params.propId;
    } else {
      const mudou = CAMPOS_RELEVANTES.filter((c) => campoMudou(antes, depois, c));
      precisa = mudou.length > 0 && (eraPublicado || ehPublicado);
      motivo = 'update:' + event.params.propId + ':' + mudou.join(',');
    }

    if (!precisa) return null;

    try {
      await reconstruirComDebounce(motivo);
    } catch (err) {
      logger.error('Falha ao reconstruir catalogo', { err: err.message, motivo });
    }
    return null;
  }
);

/**
 * Rede de seguranca: reconstroi se ficou sujo pelo debounce, e faz a primeira
 * geracao sozinho depois do deploy (quando api_catalog/meta ainda nao existe).
 */
exports.flushCatalogoImoveis = onSchedule(
  { schedule: 'every 15 minutes', region: REGIAO },
  async () => {
    const snap = await refMeta().get();
    if (!snap.exists) {
      await reconstruirCatalogo('primeira-geracao');
      return;
    }
    const data = snap.data();
    if (data.sujo) await reconstruirCatalogo('flush:' + (data.motivoPendente || 'desconhecido'));
  }
);
