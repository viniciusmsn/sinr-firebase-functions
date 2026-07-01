
/












































































































































































































































































































































































































































































































Index · JS
/**
 * Cloud Function: triggerSiteRebuild
 *
 * Dispara o Deploy Hook da Cloudflare Pages quando um imovel muda em campos
 * que afetam o que o site novo (Astro estatico em seuimovelnarepresa.com.br) mostra.
 *
 * Trigger: onWrite em properties/{propId}
 * Action:  POST no DEPLOY_HOOK_URL (vazio) -> Cloudflare reconstroi o site
 *
 * DEPLOY_HOOK_URL vem via arquivo .env (nao commitado) ou como env var
 * setada pelo pipeline de deploy (GitHub Actions).
 */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
 
admin.initializeApp();
 
// Campos que, quando mudam, afetam o conteudo renderizado no site.
const SITE_RELEVANT_FIELDS = [
  'publishToSite',
  'wpPostId',
  'dealStatus',
  'submissionStatus',
  'titulo',
  'codigo',
  'precoVenda',
  'precoLocacao',
  'descricao',
  'bairro',
  'cidade',
  'recursos',
  'media',
  'lat',
  'lng',
  '_forceRebuildAt', // v5.159: botao "Atualizar no site" seta esse campo pra forcar rebuild
];
 
// Campos que, quando sao os UNICOS a mudarem, sinalizam "rebuild forcado"
// (bypass do debounce). O usuario apertou explicitamente "Atualizar no site".
const FORCE_REBUILD_FIELDS = ['_forceRebuildAt'];
 
// Debounce minimo entre rebuilds (em ms). Aplicado em mudancas comuns.
// Bypass quando o usuario aperta explicitamente "Atualizar no site".
const REBUILD_DEBOUNCE_MS = 2 * 60 * 1000; // 2 minutos
 
function fieldChanged(before, after, field) {
  return JSON.stringify(before ? before[field] : undefined) !==
         JSON.stringify(after  ? after[field]  : undefined);
}
 
function isPublishedNow(data) {
  if (!data) return false;
  return data.publishToSite === true || !!data.wpPostId;
}
 
async function fireDeployHook(url, reason) {
  const resp = await fetch(url, { method: 'POST' });
  const text = await resp.text().catch(() => '');
  logger.info('Deploy hook acionado', {
    reason,
    status: resp.status,
    bodyPreview: text.slice(0, 200),
  });
  if (!resp.ok) {
    throw new Error(`Deploy hook respondeu ${resp.status}: ${text.slice(0, 200)}`);
  }
}
 
async function maybeDispatchRebuild(reason, opts) {
  const bypassDebounce = !!(opts && opts.bypassDebounce);
  const url = process.env.DEPLOY_HOOK_URL;
  if (!url) {
    logger.warn('DEPLOY_HOOK_URL nao configurado como env var');
    return;
  }
  const db = admin.firestore();
  const ref = db.doc('_meta/buildScheduler');
  const now = Date.now();
 
  // Rebuild forcado: ignora debounce e dispara imediatamente.
  if (bypassDebounce) {
    logger.info('Rebuild forcado (bypass debounce)', { reason });
    await fireDeployHook(url, reason);
    await ref.set({
      lastBuildAt: now,
      pendingSince: null,
      pendingReason: null,
      lastReason: 'forced:' + reason,
    }, { merge: true });
    return;
  }
 
  // Rebuild normal: aplica debounce em transacao.
  const result = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : { lastBuildAt: 0 };
    const elapsed = now - (data.lastBuildAt || 0);
    if (elapsed < REBUILD_DEBOUNCE_MS) {
      tx.set(ref, {
        pendingSince: data.pendingSince || now,
        pendingReason: reason,
        lastBuildAt: data.lastBuildAt || 0,
      }, { merge: true });
      return { dispatch: false, elapsed };
    }
    tx.set(ref, {
      lastBuildAt: now,
      pendingSince: null,
      pendingReason: null,
      lastReason: reason,
    }, { merge: true });
    return { dispatch: true, elapsed };
  });
 
  if (result.dispatch) {
    await fireDeployHook(url, reason);
  } else {
    logger.info('Rebuild debounciado', {
      reason,
      elapsedMs: result.elapsed,
      minWaitMs: REBUILD_DEBOUNCE_MS,
    });
  }
}
 
exports.triggerSiteRebuild = onDocumentWritten(
  {
    document: 'properties/{propId}',
    region: 'us-central1',
  },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.exists
      ? event.data.before.data()
      : null;
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data()
      : null;
 
    let shouldRebuild = false;
    let reason = '';
    let bypassDebounce = false;
 
    if (!after) {
      shouldRebuild = isPublishedNow(before);
      reason = 'delete:' + event.params.propId;
    } else if (!before) {
      shouldRebuild = isPublishedNow(after);
      reason = 'create:' + event.params.propId;
    } else {
      const changedFields = SITE_RELEVANT_FIELDS.filter(f => fieldChanged(before, after, f));
      shouldRebuild = changedFields.length > 0 && (isPublishedNow(before) || isPublishedNow(after));
      reason = 'update:' + event.params.propId + ':' + changedFields.join(',');
      // v5.159: se _forceRebuildAt esta entre os campos mudados, bypass do debounce
      bypassDebounce = changedFields.some(f => FORCE_REBUILD_FIELDS.includes(f));
    }
 
    if (!shouldRebuild) {
      logger.info('Skip rebuild (sem mudanca relevante ou imovel nao publicado)', {
        propId: event.params.propId,
        publishedBefore: isPublishedNow(before),
        publishedAfter:  isPublishedNow(after),
      });
      return null;
    }
 
    try {
      await maybeDispatchRebuild(reason, { bypassDebounce });
    } catch (err) {
      logger.error('Falha ao disparar rebuild', { err: err.message, reason });
    }
    return null;
  }
);
 
exports.flushPendingRebuilds = onSchedule(
  {
    schedule: 'every 5 minutes',
    region: 'us-central1',
  },
  async () => {
    const db = admin.firestore();
    const ref = db.doc('_meta/buildScheduler');
    const snap = await ref.get();
    if (!snap.exists) return;
    const data = snap.data();
    if (!data.pendingSince) return;
    const now = Date.now();
    const elapsedSinceLastBuild = now - (data.lastBuildAt || 0);
    if (elapsedSinceLastBuild < REBUILD_DEBOUNCE_MS) {
      logger.info('Pendente ainda dentro do debounce, esperando proximo tick', {
        elapsedSinceLastBuild,
      });
      return;
    }
    const url = process.env.DEPLOY_HOOK_URL;
    if (!url) {
      logger.warn('DEPLOY_HOOK_URL nao configurado como env var');
      return;
    }
    try {
      await fireDeployHook(url, 'scheduled-flush:' + (data.pendingReason || 'unknown'));
      await ref.set({
        lastBuildAt: now,
        pendingSince: null,
        pendingReason: null,
        lastReason: 'scheduled-flush',
      }, { merge: true });
    } catch (err) {
      logger.error('Falha ao disparar rebuild agendado', err);
    }
  }
);
 

Não foi possível abrir o arquivo.
