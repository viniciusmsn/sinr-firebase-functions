/**
 * Feed de portais — ZAP, VivaReal e OLX (via Canal Pro), no padrao VRSync.
 *
 * Cloud Function exportada: feedPortais (HTTP).
 *
 *   GET /feedPortais/vrsync/{token}.xml   -> o XML que o Canal Pro le
 *   GET /feedPortais/relatorio/{token}    -> JSON: quem entrou, quem ficou de fora e por que
 *
 * Plugado no index.js com:
 *   Object.assign(exports, require('./feedPortais'));
 *
 * Por que o token vai na URL: o robo do portal (VivaRealBot) so sabe baixar uma
 * URL — nao manda cabecalho. A URL inteira e o segredo; o Firestore guarda so o
 * sha256 em feed_portais_tokens/. Token desconhecido responde 404, nao 401, pra
 * nao confirmar que o endpoint existe.
 *
 * Por que nao tem catalogo materializado (como a apiImoveis): o portal le 2x por
 * dia. Gerar sob demanda custa uma leitura por imovel publicado por geracao, e o
 * cache de instancia (15 min) segura rajada. Nenhum trigger novo. A config e
 * relida a cada requisicao, entao mudanca nela vale na hora.
 *
 * Config em feed_portais/config — ver feedPortaisAdmin.js.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');

const core = require('./feedPortaisCore');

if (!admin.apps.length) admin.initializeApp();

const REGIAO = 'us-central1';
const CACHE_FEED_MS = 15 * 60 * 1000;
const CACHE_TOKEN_MS = 5 * 60 * 1000;
const CACHE_TOKEN_NEGATIVO_MS = 60 * 1000;
const GRAVA_ACESSO_A_CADA_MS = 10 * 60 * 1000;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

const _tokens = new Map(); // hash -> { id | null, expiraEm }
const _acessos = new Map(); // id -> ultimo carimbo gravado

async function validarToken(bruto) {
  // Formato fixo: evita gastar leitura com lixo e limita o que entra no hash.
  if (!/^[A-Za-z0-9_-]{32,64}$/.test(bruto)) return null;
  const hash = sha256(bruto);
  const agora = Date.now();

  const c = _tokens.get(hash);
  if (c && c.expiraEm > agora) return c.id;

  const snap = await admin.firestore()
    .collection('feed_portais_tokens').where('hash', '==', hash).limit(1).get();
  const doc = snap.empty ? null : snap.docs[0];
  const id = doc && doc.data().ativo === true ? doc.id : null;

  _tokens.set(hash, { id, expiraEm: agora + (id ? CACHE_TOKEN_MS : CACHE_TOKEN_NEGATIVO_MS) });
  return id;
}

/** Registra a leitura — e assim que se ve, no admin, que o robo do portal esta vindo. */
async function registrarAcesso(tokenId, req, incluidos) {
  const agora = Date.now();
  if (agora - (_acessos.get(tokenId) || 0) < GRAVA_ACESSO_A_CADA_MS) return;
  _acessos.set(tokenId, agora);
  try {
    await admin.firestore().collection('feed_portais_tokens').doc(tokenId).set({
      ultimoAcesso: new Date(agora).toISOString(),
      ultimoUserAgent: String(req.get('User-Agent') || '').slice(0, 200),
      ultimoTotalAnuncios: incluidos,
      acessos: admin.firestore.FieldValue.increment(1),
    }, { merge: true });
  } catch (err) {
    logger.warn('Falha ao registrar acesso ao feed', { tokenId, err: err.message });
  }
}

// ---------------------------------------------------------------------------
// Geracao (com cache de instancia)
// ---------------------------------------------------------------------------

let _feed = { xml: null, relatorio: null, geradoEm: 0, versaoCfg: null };
let _gerando = null;
let _gerandoVersao = null;

async function gerar(cfg, versaoCfg) {
  // select(): os campos do proprietario nem chegam a entrar na memoria da function.
  const propsSnap = await admin.firestore()
    .collection('properties').where('publishToSite', '==', true).select(...core.CAMPOS_LIDOS).get();
  const docs = propsSnap.docs.map((d) => d.data());
  const r = core.gerarFeed(docs, cfg, new Date());
  logger.info('Feed de portais gerado', {
    candidatos: r.relatorio.candidatos,
    incluidos: r.relatorio.incluidos,
    excluidos: r.relatorio.excluidos.length,
    bytes: r.xml ? Buffer.byteLength(r.xml, 'utf8') : 0,
    erro: r.relatorio.erro,
  });
  return { xml: r.xml, relatorio: r.relatorio, geradoEm: Date.now(), ativo: cfg.ativo !== false, versaoCfg };
}

/**
 * A config e lida a CADA requisicao (1 leitura; o portal faz 2 por dia): mudar
 * modo, limite, CEP ou desligar o feed vale na hora, sem esperar cache vencer —
 * `--ativo nao` e um botao de emergencia e nao pode demorar 15 minutos.
 * So a lista de imoveis fica em cache.
 */
async function obterFeed() {
  const cfgSnap = await admin.firestore().doc('feed_portais/config').get();
  const cfg = cfgSnap.exists ? cfgSnap.data() : {};
  const versao = String(cfg.atualizadoEm || '');

  if (_feed.relatorio && _feed.versaoCfg === versao && (Date.now() - _feed.geradoEm) < CACHE_FEED_MS) return _feed;
  // Duas requisicoes simultaneas com cache frio compartilham a mesma geracao.
  if (!_gerando || _gerandoVersao !== versao) {
    _gerandoVersao = versao;
    const esta = gerar(cfg, versao).then((f) => { _feed = f; return f; });
    _gerando = esta;
    esta.catch(() => {}).then(() => { if (_gerando === esta) { _gerando = null; _gerandoVersao = null; } });
  }
  return _gerando;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function naoEncontrado(res) {
  res.set('Cache-Control', 'no-store');
  res.status(404).type('text/plain').send('Not found');
}

exports.feedPortais = onRequest(
  { region: REGIAO, cors: false, maxInstances: 3, memory: '512MiB', timeoutSeconds: 120 },
  async (req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.set('Allow', 'GET, HEAD');
      res.status(405).type('text/plain').send('Method not allowed');
      return;
    }

    const caminho = String(req.path || '/').replace(/^\/feedPortais/, '');
    const mXml = caminho.match(/^\/vrsync\/([^/]+)\.xml$/);
    const mRel = caminho.match(/^\/relatorio\/([^/]+?)(?:\.json)?$/);
    if (!mXml && !mRel) { naoEncontrado(res); return; }

    try {
      const tokenId = await validarToken((mXml || mRel)[1]);
      if (!tokenId) { naoEncontrado(res); return; }

      const feed = await obterFeed();
      // A URL e um segredo: nada de cache em intermediario.
      res.set('Cache-Control', 'no-store');

      if (mRel) {
        res.status(200).json(feed.relatorio);
        return;
      }

      if (!feed.ativo) {
        res.status(503).type('text/plain').send('Feed desativado em feed_portais/config.');
        return;
      }
      if (!feed.xml) {
        res.status(503).type('text/plain').send('Feed nao configurado: ' + feed.relatorio.erro);
        return;
      }

      res.set('Content-Type', 'application/xml; charset=utf-8');
      res.status(200).send(req.method === 'HEAD' ? '' : feed.xml);
      await registrarAcesso(tokenId, req, feed.relatorio.incluidos);
    } catch (err) {
      logger.error('Erro no feedPortais', { err: err.message, stack: err.stack });
      res.set('Cache-Control', 'no-store');
      res.status(500).type('text/plain').send('Erro interno.');
    }
  }
);
