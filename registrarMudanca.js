/**
 * registrarMudanca — alimenta o feed de mudancas do CRM (_mudancas/).
 *
 * ============================================================================
 * COMO PLUGAR NO index.js (nao reescreva o index.js inteiro)
 * ============================================================================
 *   // No FINAL do index.js, DEPOIS do admin.initializeApp():
 *   Object.assign(exports, require('./registrarMudanca'));
 * ============================================================================
 *
 * POR QUE ELA EXISTE
 *
 * Na Fase 2 do caminho B o navegador deixa de assinar o Firestore (onSnapshot).
 * O tempo real passa a ser o navegador perguntando ao Worker sinr-crm-api, a
 * cada ~8 s, "o que mudou desde X?" — e o Worker responde lendo _mudancas/.
 *
 * O Worker sozinho so sabe do que passa por ele. propostaPublica, o robo do
 * n8n e backfillWatermark gravam direto no Firestore; sem esta function, essas
 * gravacoes so apareceriam no CRM quando a pessoa recarregasse a pagina.
 * Por isso, em producao, quem escreve o feed e esta function, para TODAS as
 * gravacoes, e o Worker roda com FEED=funcao (nao escreve, para nao duplicar).
 *
 * FORMATO (igual ao que o Worker escreve — crm-worker/src/firestore.js):
 *   _mudancas/{auto} = { col, caminho: "<col>/<id>", apagado, origem: "funcao",
 *                        ts: hora do servidor, expiraEm: ts + 3 dias }
 * O documento so diz QUE mudou. O conteudo o Worker le na hora e filtra pelo
 * papel de quem pergunta — nada de dado de cliente fica no feed.
 *
 * LIMPEZA: politica de TTL do Firestore no campo expiraEm (criada a parte,
 * ver FASE-2-CAMINHO-B.md). Sem ela o feed so cresce.
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();

const REGIAO = 'us-central1';
const FEED_DIAS = 3;

// As colecoes que o CRM mostra em tempo real (as que tinham onSnapshot).
const COLECOES = ['properties', 'clients', 'bairros', 'users', 'equipes', 'proposals', 'searches', 'visits'];

function registrar(col) {
  return onDocumentWritten({ document: `${col}/{id}`, region: REGIAO, retry: false }, async (event) => {
    const id = event.params.id;
    const apagado = !(event.data && event.data.after && event.data.after.exists);
    try {
      await admin.firestore().collection('_mudancas').add({
        col,
        caminho: `${col}/${id}`,
        apagado,
        origem: 'funcao',
        ts: admin.firestore.FieldValue.serverTimestamp(),
        expiraEm: admin.firestore.Timestamp.fromMillis(Date.now() + FEED_DIAS * 86400000),
      });
    } catch (e) {
      // sem retry: no pior caso a mudanca aparece no proximo carregamento da pagina
      logger.error('registrarMudanca falhou', { col, id, erro: e.message });
    }
  });
}

// registrarMudancaProperties, registrarMudancaClients, ...
for (const col of COLECOES) {
  exports['registrarMudanca' + col[0].toUpperCase() + col.slice(1)] = registrar(col);
}
