/**
 * backfillWatermark — Cloud Function (callable) que aplica watermark do logo
 * em fotos armazenadas no Firebase Storage.
 *
 * Fluxo:
 *   1. Client (admin) chama httpsCallable('backfillWatermark', { mode, maxDocs, startAfter })
 *   2. CF valida auth + role='admin'
 *   3. Carrega logo do Storage (path em settings/imobiliaria.watermarkLogoStoragePath
 *      ou fallback 'settings/watermark-logo.png')
 *   4. Query properties ordenado por __name__, limite maxDocs, cursor startAfter
 *   5. Pra cada media[i] com storagePath e sem watermarked:true:
 *      - Se mode='dry-run': só conta
 *      - Se mode='apply': baixa, watermarcarca com sharp, sobe de volta ao mesmo path,
 *        marca media[i].watermarked=true + watermarkedAt=Date.now()
 *   6. Retorna { scanned, wouldWatermark, watermarked, skippedDrive, skippedAlready, errors, nextCursor }
 *
 * Skip explicito: fotos com driveFileId mas sem storagePath (Drive-only) contam em
 * skippedDrive — precisam backfill client-side separado.
 *
 * Idempotencia: marca watermarked:true na media, entao rerun nao refaz.
 *
 * Deploy: precisa de sharp no package.json. Segunda invocacao vai reusar container
 * quente e ficar rapida (~200-500ms/foto).
 *
 * MemoryOption: 512MB (sharp precisa espaco), timeout 540s (max pra callable).
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');

const DEFAULT_LOGO_STORAGE_PATH = 'settings/watermark-logo.png';
const WATERMARK_OPACITY = 0.4;           // 40% opacidade
const WATERMARK_WIDTH_RATIO = 0.15;      // 15% da largura da foto
const WATERMARK_WIDTH_CAP = 200;         // cap 200px pra fotos grandes ficarem discretas
const WATERMARK_PADDING_RATIO = 0.01;    // 1% da largura da foto
const WATERMARK_PADDING_MIN = 10;        // minimo 10px

let cachedLogo = null;    // Buffer do logo (in-memory, reusado entre invocacoes quentes)
let cachedLogoPath = null;

async function loadWatermarkLogo(storagePath) {
  if (cachedLogo && cachedLogoPath === storagePath) return cachedLogo;
  const bucket = admin.storage().bucket();
  const file = bucket.file(storagePath);
  const [exists] = await file.exists();
  if (!exists) throw new Error(`Logo nao encontrado em Storage: ${storagePath}`);
  const [buf] = await file.download();
  cachedLogo = buf;
  cachedLogoPath = storagePath;
  logger.info('Logo carregado', { path: storagePath, sizeBytes: buf.length });
  return buf;
}

/**
 * Aplica watermark bottom-right numa foto usando sharp.
 * @param {Buffer} photoBuf - foto original (jpeg/png/webp)
 * @param {Buffer} logoBuf - logo em qualquer formato compativel com sharp
 * @returns {Promise<{outBuf: Buffer, outContentType: string}>}
 */
async function applyWatermarkSharp(photoBuf, logoBuf) {
  const sharp = require('sharp');
  const photoMeta = await sharp(photoBuf).metadata();
  const photoW = photoMeta.width;
  const photoH = photoMeta.height;
  if (!photoW || !photoH) throw new Error('Foto sem dimensoes validas');

  // Calcula tamanho do watermark
  const targetW = Math.min(Math.round(photoW * WATERMARK_WIDTH_RATIO), WATERMARK_WIDTH_CAP);
  const pad = Math.max(WATERMARK_PADDING_MIN, Math.round(photoW * WATERMARK_PADDING_RATIO));

  // Resize logo mantendo aspect ratio + aplicar opacidade
  const logoResized = await sharp(logoBuf)
    .resize({ width: targetW })
    // Aplica opacidade multiplicando alpha channel
    .composite([{
      input: Buffer.from([255, 255, 255, Math.round(255 * WATERMARK_OPACITY)]),
      raw: { width: 1, height: 1, channels: 4 },
      tile: true,
      blend: 'dest-in',  // preserva pixels do logo, aplica alpha global
    }])
    .png()
    .toBuffer();

  const logoMeta = await sharp(logoResized).metadata();
  const logoH = logoMeta.height;

  const left = photoW - targetW - pad;
  const top = photoH - logoH - pad;

  // Compoe logo no canto inferior direito da foto, mantem formato original
  const outBuf = await sharp(photoBuf)
    .composite([{ input: logoResized, left, top }])
    .jpeg({ quality: 85 })  // sempre re-encode como jpeg (menor)
    .toBuffer();

  return { outBuf, outContentType: 'image/jpeg' };
}

exports.backfillWatermark = onCall(
  {
    region: 'us-central1',
    memory: '512MiB',
    timeoutSeconds: 540,
    cors: true,
  },
  async (request) => {
    // ==== Auth check ====
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Login necessario');
    const userDoc = await admin.firestore().doc(`users/${uid}`).get();
    const role = userDoc.exists ? userDoc.data()?.role : null;
    if (role !== 'admin') throw new HttpsError('permission-denied', 'Apenas admin pode rodar backfill');

    // ==== Params ====
    const { mode = 'dry-run', maxDocs = 25, startAfter = null } = request.data || {};
    if (mode !== 'dry-run' && mode !== 'apply') {
      throw new HttpsError('invalid-argument', 'mode deve ser dry-run ou apply');
    }
    if (typeof maxDocs !== 'number' || maxDocs < 1 || maxDocs > 100) {
      throw new HttpsError('invalid-argument', 'maxDocs deve estar entre 1 e 100');
    }

    logger.info('backfillWatermark start', { mode, maxDocs, startAfter, uid });

    // ==== Load logo (only if we'll actually apply — dry-run pode pular pra ser mais rapido) ====
    let logoBuf = null;
    if (mode === 'apply') {
      const settingsSnap = await admin.firestore().doc('settings/imobiliaria').get();
      const logoPath = settingsSnap.exists
        ? (settingsSnap.data()?.watermarkLogoStoragePath || DEFAULT_LOGO_STORAGE_PATH)
        : DEFAULT_LOGO_STORAGE_PATH;
      logoBuf = await loadWatermarkLogo(logoPath);
    }

    // ==== Query properties ====
    let q = admin.firestore().collection('properties').orderBy('__name__').limit(maxDocs);
    if (startAfter) q = q.startAfter(startAfter);
    const snap = await q.get();

    const results = {
      mode,
      scanned: 0,
      wouldWatermark: 0,
      watermarked: 0,
      skippedDrive: 0,
      skippedAlready: 0,
      skippedNonImage: 0,
      errors: [],
      lastDocId: null,
      nextCursor: null,
    };

    const bucket = admin.storage().bucket();

    for (const doc of snap.docs) {
      results.lastDocId = doc.id;
      results.scanned++;
      const p = doc.data();
      const media = Array.isArray(p.media) ? p.media.slice() : [];
      let docHadChanges = false;

      for (let i = 0; i < media.length; i++) {
        const m = media[i] || {};
        if (!m.storagePath) {
          if (m.driveFileId) results.skippedDrive++;
          continue;
        }
        if (!(m.type || '').startsWith('image/')) { results.skippedNonImage++; continue; }
        if (m.watermarked) { results.skippedAlready++; continue; }

        if (mode === 'dry-run') {
          results.wouldWatermark++;
          continue;
        }

        // ==== Apply ====
        try {
          const [photoBuf] = await bucket.file(m.storagePath).download();
          const { outBuf, outContentType } = await applyWatermarkSharp(photoBuf, logoBuf);
          await bucket.file(m.storagePath).save(outBuf, {
            contentType: outContentType,
            resumable: false,
            metadata: {
              cacheControl: 'public, max-age=31536000',
              metadata: {
                watermarkedAt: String(Date.now()),
                watermarkedBy: 'backfillWatermark',
              },
            },
          });
          media[i] = { ...m, watermarked: true, watermarkedAt: Date.now(), type: outContentType };
          docHadChanges = true;
          results.watermarked++;
        } catch (err) {
          logger.warn('Falha ao watermarcar foto', { docId: doc.id, photoIndex: i, err: err.message });
          results.errors.push({
            docId: doc.id,
            photoIndex: i,
            path: m.storagePath,
            err: err.message,
          });
        }
      }

      if (docHadChanges && mode === 'apply') {
        try {
          await doc.ref.update({ media, updatedAt: Date.now() });
        } catch (err) {
          logger.error('Falha ao atualizar doc apos watermark', { docId: doc.id, err: err.message });
          results.errors.push({ docId: doc.id, err: 'firestore update: ' + err.message });
        }
      }
    }

    // Cursor pra continuar: se snap teve size >= maxDocs, tem mais paginas
    if (snap.size >= maxDocs && results.lastDocId) {
      results.nextCursor = results.lastDocId;
    }

    logger.info('backfillWatermark done', results);
    return results;
  }
);
