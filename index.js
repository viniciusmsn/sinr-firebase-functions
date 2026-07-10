/**
 * Cloud Functions do projeto Seu Imóvel na Represa.
 *
 * triggerSiteRebuild        — onWrite em properties/{id}, dispara rebuild.
 * triggerSiteRebuildBairros — onWrite em bairros/{id}, dispara rebuild.
 * flushPendingRebuilds      — cron a cada 5min, varre pendências do debounce.
 * backfillWatermark         — httpsCallable, aplica watermark em fotos do Storage.
 *
 * DEPLOY_HOOK_URL vem via .env.<projectId> (carregado automaticamente pelo
 * Firebase Functions v2) ou como env var setada pelo pipeline de deploy
 * (GitHub Actions grava .env.seuimovelnarepresa a cada run).
 */
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

// Campos de `properties/` que, quando mudam, afetam o conteudo do site.
const PROPERTY_SITE_FIELDS = [
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
  '_forceRebuildAt',
];

// Campos "forcam" rebuild imediato (bypass debounce)
const FORCE_REBUILD_FIELDS = ['_forceRebuildAt'];

// Debounce minimo entre rebuilds
const REBUILD_DEBOUNCE_MS = 2 * 60 * 1000; // 2 minutos

function fieldChanged(before, after, field) {
  return JSON.stringify(before ? before[field] : undefined) !==
         JSON.stringify(after  ? after[field]  : undefined);
}

function isPropertyPublished(data) {
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

// ==========================================================================
// PROPERTIES trigger
// ==========================================================================
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
      shouldRebuild = isPropertyPublished(before);
      reason = 'property-delete:' + event.params.propId;
    } else if (!before) {
      shouldRebuild = isPropertyPublished(after);
      reason = 'property-create:' + event.params.propId;
    } else {
      const changedFields = PROPERTY_SITE_FIELDS.filter(f => fieldChanged(before, after, f));
      shouldRebuild = changedFields.length > 0 &&
        (isPropertyPublished(before) || isPropertyPublished(after));
      reason = 'property-update:' + event.params.propId + ':' + changedFields.join(',');
      bypassDebounce = changedFields.some(f => FORCE_REBUILD_FIELDS.includes(f));
    }

    if (!shouldRebuild) {
      logger.info('Skip property rebuild', {
        propId: event.params.propId,
        publishedBefore: isPropertyPublished(before),
        publishedAfter:  isPropertyPublished(after),
      });
      return null;
    }

    try {
      await maybeDispatchRebuild(reason, { bypassDebounce });
    } catch (err) {
      logger.error('Falha ao disparar rebuild (property)', { err: err.message, reason });
    }
    return null;
  }
);

// ==========================================================================
// BAIRROS trigger (v5.163)
// Qualquer criação/edição/deleção de doc em bairros/ dispara rebuild.
// Não filtra campos porque TUDO em `bairros/` é conteúdo renderizado no site.
// ==========================================================================
exports.triggerSiteRebuildBairros = onDocumentWritten(
  {
    document: 'bairros/{bairroId}',
    region: 'us-central1',
  },
  async (event) => {
    const before = event.data && event.data.before && event.data.before.exists
      ? event.data.before.data()
      : null;
    const after = event.data && event.data.after && event.data.after.exists
      ? event.data.after.data()
      : null;

    let reason;
    if (!after) reason = 'bairro-delete:' + event.params.bairroId;
    else if (!before) reason = 'bairro-create:' + event.params.bairroId;
    else reason = 'bairro-update:' + event.params.bairroId;

    try {
      await maybeDispatchRebuild(reason, { bypassDebounce: false });
    } catch (err) {
      logger.error('Falha ao disparar rebuild (bairro)', { err: err.message, reason });
    }
    return null;
  }
);

// ==========================================================================
// Scheduler: varre pendências que ficaram bloqueadas pelo debounce
// ==========================================================================
// ==========================================================================
// backfillWatermark — HTTPS callable (admin only)
// Aplica watermark em fotos armazenadas no Firebase Storage.
// Iterativo, com cursor, dry-run por padrao.
// ==========================================================================
exports.backfillWatermark = require('./backfillWatermark').backfillWatermark;

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
