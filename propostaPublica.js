/**
 * propostaPublica — acesso das partes a UMA negociacao, validado no servidor.
 *
 * ============================================================================
 * COMO PLUGAR NO index.js (nao reescreva o index.js inteiro)
 * ============================================================================
 *   // No FINAL do index.js, DEPOIS do admin.initializeApp():
 *   Object.assign(exports, require('./propostaPublica'));
 * ============================================================================
 *
 * POR QUE ELA EXISTE
 *
 * Ate 27/08/2026 os fluxos ?aceite=, ?compra= e ?dossie= liam e escreviam
 * direto em proposals/ pelo SDK do navegador. Para isso funcionar sem login,
 * a regra do Firestore precisava liberar proposals para qualquer um — e
 * liberava mesmo, com `allow read: if true` e `allow update: if true`.
 *
 * Com esta function, o token deixa de ser uma senha que abre a colecao inteira
 * e passa a ser uma chave que abre UM documento, com campos filtrados na ida e
 * na volta. Ai a regra pode exigir papel de verdade.
 *
 * O QUE ELA GARANTE
 *   1. Quem tem o token do comprador nao le nem escreve nada do vendedor.
 *   2. Nenhum token sai na resposta, exceto o que o proprio chamador ja tem.
 *   3. Dinheiro da imobiliaria (commissionPayment) e nota interna (history)
 *      nunca saem para as partes.
 *   4. A gravacao passa por whitelist por escopo. Campo fora dela e recusado
 *      com 400, em vez de ser ignorado em silencio — erro silencioso aqui
 *      viraria "preenchi e nao salvou".
 *   5. Um signatario so altera o proprio registro dentro de signatarios[].
 */

const { onRequest } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const REGIAO = 'us-central1';

// Origens que podem chamar. O app e servido do dominio do CRM; o localhost
// fica para depurar da maquina do Vinicius.
const ORIGENS = [
  'https://app.seuimovelnarepresa.com.br',
  'https://demo.corretto.app.br',
  // Fase 2 do caminho B: homologacao do CRM servido pelo Worker, banco de producao
  'https://crm-novo.seuimovelnarepresa.com.br',
  'http://localhost:5000',
  'http://localhost:8080',
];

// ---------------------------------------------------------------------------
// Campos que NUNCA saem, em nenhum escopo.
// ---------------------------------------------------------------------------
const NUNCA_SAI = [
  'commissionPayment',   // rateio, percentuais, valores da imobiliaria
  'history',             // notas internas de negociacao
  'revisaoDocumental',   // fila interna
  'buyerToken',
  'acceptanceToken',
  'signatarioTokens',
  'assignedTo', 'sentBy', 'sentByName', 'updatedBy',
  'driveFolderId', 'driveSyncedAt',
];

/* Whitelist de escrita por escopo.

   28/08 — a primeira lista foi montada de cabeca e estava incompleta: faltavam
   acceptanceStartedAt, refusedAt, sellerInfoUpdatedAt, dealStage,
   dealStageUpdatedAt, buyerStartedAt, buyerCancelledAt, buyerStatus,
   buyerInfoUpdatedAt e buyerDocsUploadedAt. O efeito era o pior possivel: o
   PRIMEIRO botao do fluxo do vendedor devolvia 400 e a tela nao saia do lugar.
   Esta versao veio de ler os dois fluxos linha a linha, nao de memoria. */
const PODE_GRAVAR = {
  aceite: [
    'acceptanceStage', 'acceptanceStartedAt',
    'sellerInfo', 'sellerInfoUpdatedAt', 'sellerDocs', 'sellerSignedAt',
    'docsUploadedAt', 'sellerPaidDeclaredAt',
    'signatarios', 'signatarioTokens',
    'status', 'refusedAt',
    'dealStage', 'dealStageUpdatedAt',
  ],
  compra: [
    'buyerStage', 'buyerStartedAt', 'buyerCancelledAt',
    'buyerInfo', 'buyerInfoUpdatedAt', 'buyerDocs', 'buyerDocsUploadedAt',
    'buyerSignedAt', 'buyerPaidDeclaredAt', 'buyerStatus',
    'docsUploadedAt',
    'status',
    'dealStage', 'dealStageUpdatedAt',
  ],
  dossie: [],   // consulta apenas
};

/* dealStage entra na whitelist porque a assinatura avanca o funil. Mas deixar
   o valor livre daria a quem tem o link o poder de marcar o negocio como
   ganho. So os estagios que a assinatura realmente produz sao aceitos. */
const DEAL_STAGE_PERMITIDO = ['enviada', 'negociacao', 'aceita', 'pagamento', 'documentacao'];

/* status/buyerStatus idem: sao rotulos de fluxo, nao devem virar campo livre. */
const STATUS_PERMITIDO = [
  'sent', 'accepted_seller', 'docs_uploaded_seller', 'awaiting_admin_review',
  'refused_by_seller', 'cancelled_by_buyer', 'accepted_buyer', 'docs_uploaded_buyer',
];

// ---------------------------------------------------------------------------
function cors(req, res) {
  const origem = req.headers.origin || '';
  if (ORIGENS.includes(origem)) res.set('Access-Control-Allow-Origin', origem);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '3600');
  return ORIGENS.includes(origem);
}

function erro(res, status, msg) {
  return res.status(status).json({ ok: false, erro: msg });
}

/** Acha a proposta pelo token e diz QUEM e o portador. */
async function resolveToken(db, escopo, token) {
  const col = db.collection('proposals');

  if (escopo === 'dossie') {
    const s = await col.where('dossie.token', '==', token).limit(1).get();
    return s.empty ? null : { doc: s.docs[0], signatario: null };
  }

  if (escopo === 'compra') {
    const s = await col.where('buyerToken', '==', token).limit(1).get();
    return s.empty ? null : { doc: s.docs[0], signatario: null };
  }

  if (escopo === 'aceite') {
    // dono unico (fluxo antigo)
    const s = await col.where('acceptanceToken', '==', token).limit(1).get();
    if (!s.empty) return { doc: s.docs[0], signatario: null };
    // socios: espelho de tokens em array de strings, porque o Firestore nao
    // indexa array de objetos por campo interno
    const s2 = await col.where('signatarioTokens', 'array-contains', token).limit(1).get();
    if (s2.empty) return null;
    const dados = s2.docs[0].data();
    const sig = (dados.signatarios || []).find(x => x && x.token === token) || null;
    return { doc: s2.docs[0], signatario: sig };
  }

  return null;
}

/** Monta a resposta: tira o que nunca sai e reduz signatarios ao portador. */
function projetar(id, dados, escopo, signatario) {
  const out = { id };
  Object.keys(dados).forEach(k => {
    if (NUNCA_SAI.includes(k)) return;
    out[k] = dados[k];
  });

  // O dossie precisa da lista de arquivos, mas nao do token que a gerou.
  if (out.dossie) {
    const d = Object.assign({}, out.dossie);
    delete d.token;
    delete d.tokenAt;
    out.dossie = d;
  }

  const sigs = dados.signatarios || [];

  if (escopo === 'aceite' && !signatario) {
    /* Entrou pelo acceptanceToken, o link mestre do lado vendedor. Ele e
       anterior aos socios e vale pela negociacao inteira: quando ha varios
       signatarios, o app pergunta "quem esta assinando?" e precisa dos tokens
       para seguir (v5.256). Reduzir aqui quebraria esse caminho.
       Quem tem o link mestre ja podia agir por todos — nao ha ganho em esconder. */
    out.signatarios = sigs;
    delete out.buyerInfo;
    delete out.buyerDocs;

  } else if (escopo === 'aceite') {
    // Entrou com token de um socio: ve o proprio registro completo e, dos
    // demais, so o suficiente pra tela dizer quem ja assinou.
    out.signatarios = sigs.map(s => {
      if (!s) return s;
      if (s.token === signatario.token) return s;
      return {
        nome: s.nome, papel: s.papel, ordem: s.ordem,
        signedAt: s.signedAt || null,
        stage: s.stage || null,
        preenchido: !!(s.info && Object.keys(s.info).length),
      };
    });
    // ...e o vendedor nao ve os dados do comprador.
    delete out.buyerInfo;
    delete out.buyerDocs;

  } else if (escopo === 'dossie') {
    // O dossie mostra "tudo do negocio" por decisao de 27/08, entao os anexos
    // dos socios PRECISAM vir. Some so o token de cada um.
    out.signatarios = sigs.map(s => {
      if (!s) return s;
      const c = Object.assign({}, s);
      delete c.token;
      return c;
    });

  } else if (escopo === 'compra') {
    // O comprador nao ve os documentos nem os dados pessoais do vendedor.
    delete out.sellerInfo;
    delete out.sellerDocs;
    delete out.signatarios;
    delete out.dossie;
  }

  return out;
}

/** Valida o patch contra a whitelist do escopo. */
function validarPatch(escopo, patch, signatario, dadosAtuais) {
  const permitidos = PODE_GRAVAR[escopo] || [];
  if (!permitidos.length) return { ok: false, msg: 'Este link e somente de consulta.' };

  const chaves = Object.keys(patch || {});
  if (!chaves.length) return { ok: false, msg: 'Nada para gravar.' };

  const proibidas = chaves.filter(k => !permitidos.includes(k));
  if (proibidas.length) {
    return { ok: false, msg: 'Campo nao permitido neste link: ' + proibidas.join(', ') };
  }

  // valores fechados: campo permitido nao significa valor livre
  if (patch.dealStage !== undefined && !DEAL_STAGE_PERMITIDO.includes(patch.dealStage)) {
    return { ok: false, msg: 'Estagio de negocio nao permitido por link: ' + patch.dealStage };
  }
  for (const campo of ['status', 'buyerStatus']) {
    if (patch[campo] !== undefined && !STATUS_PERMITIDO.includes(patch[campo])) {
      return { ok: false, msg: 'Status nao permitido por link: ' + patch[campo] };
    }
  }

  // signatarios so pode ser tocado por quem entrou com token de signatario, e
  // ainda assim so no proprio registro. Sem isso, o token de um socio serviria
  // para reescrever os dados do outro.
  //
  // O link mestre (acceptanceToken, signatario null) e a excecao: ele vale pela
  // negociacao inteira, entao pode gravar a lista. A checagem item a item
  // abaixo so se aplica a quem entrou como socio.
  if (chaves.includes('signatarios') && signatario) {
    const antes = dadosAtuais.signatarios || [];
    const depois = patch.signatarios;
    if (!Array.isArray(depois) || depois.length !== antes.length) {
      return { ok: false, msg: 'Lista de signatarios inconsistente.' };
    }
    for (let i = 0; i < antes.length; i++) {
      const a = antes[i] || {}, b = depois[i] || {};
      if (a.token !== b.token) return { ok: false, msg: 'Signatario trocado de posicao.' };
      if (a.token === signatario.token) continue;      // o proprio: pode mudar
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        return { ok: false, msg: 'Este link so altera os dados de ' + (signatario.nome || 'quem o recebeu') + '.' };
      }
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
exports.propostaPublica = onRequest(
  { region: REGIAO, cors: false, maxInstances: 10 },
  async (req, res) => {
    const origemOk = cors(req, res);
    if (req.method === 'OPTIONS') return res.status(204).send('');
    if (req.method !== 'POST') return erro(res, 405, 'Use POST.');
    if (!origemOk) return erro(res, 403, 'Origem nao autorizada.');

    const body = req.body || {};
    const acao = String(body.acao || '').trim();
    // o cliente (v5.271) manda `tipo`; `escopo` fica como alias
    const escopo = String(body.tipo || body.escopo || '').trim();
    const token = String(body.token || '').trim();

    if (!['aceite', 'compra', 'dossie'].includes(escopo)) return erro(res, 400, 'Escopo invalido.');
    if (token.length < 8) return erro(res, 400, 'Token invalido.');

    const db = admin.firestore();

    try {
      const achado = await resolveToken(db, escopo, token);
      if (!achado) {
        logger.info('token nao encontrado', { escopo });
        return erro(res, 404, 'Link invalido, revogado ou expirado.');
      }
      const dados = achado.doc.data();

      if (acao === 'ler') {
        return res.json({ ok: true, proposta: projetar(achado.doc.id, dados, escopo, achado.signatario) });
      }

      if (acao === 'gravar') {
        const v = validarPatch(escopo, body.patch, achado.signatario, dados);
        if (!v.ok) {
          logger.warn('patch recusado', { escopo, msg: v.msg });
          return erro(res, 400, v.msg);
        }
        await achado.doc.ref.set(
          Object.assign({}, body.patch, { updatedAt: Date.now(), updatedVia: 'link:' + escopo }),
          { merge: true }
        );
        const novo = await achado.doc.ref.get();
        return res.json({ ok: true, proposta: projetar(novo.id, novo.data(), escopo, achado.signatario) });
      }

      return erro(res, 400, 'Acao invalida.');
    } catch (e) {
      logger.error('propostaPublica falhou', { erro: e.message, escopo, acao });
      return erro(res, 500, 'Erro interno.');
    }
  }
);
