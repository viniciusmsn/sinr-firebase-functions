/**
 * Logica pura da API de imoveis: normalizacao, whitelist e filtros.
 *
 * Sem dependencia de firebase — de proposito. Isso e o que decide o que sai
 * na resposta publica, entao precisa ser testavel sozinho (`node testeApiImoveis.js`).
 *
 * Este arquivo NAO exporta Cloud Functions. Nao pode ser referenciado no
 * Object.assign(exports, ...) do index.js.
 */

const CASAS_DECIMAIS_COORD = 3;   // ~110 m
const LARGURA_FOTO = 1600;
const LARGURA_THUMB = 400;

// ---------------------------------------------------------------------------
// Normalizacao
// ---------------------------------------------------------------------------

function semAcento(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Aceita number, "850000", "850.000,00" e "R$ 850.000". Devolve number ou null. */
function paraNumero(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');   // pt-BR: 850.000,00
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, ''); // pt-BR: 850.000
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

function paraInteiro(v) {
  const n = paraNumero(v);
  return n == null ? null : Math.trunc(n);
}

function arredondaCoord(v) {
  const n = paraNumero(v);
  if (n == null) return null;
  const f = Math.pow(10, CASAS_DECIMAIS_COORD);
  return Math.round(n * f) / f;
}

/** Timestamp do Firestore, Date, numero ou string -> ISO 8601. */
function paraIso(v) {
  if (!v) return null;
  try {
    if (typeof v.toDate === 'function') return v.toDate().toISOString();
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString();
    if (typeof v === 'number') { const d = new Date(v); return isNaN(d.getTime()) ? null : d.toISOString(); }
    if (typeof v === 'object' && typeof v._seconds === 'number') return new Date(v._seconds * 1000).toISOString();
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Whitelist
// ---------------------------------------------------------------------------

/**
 * Monta a URL publica de uma foto.
 *
 * Fotos do Storage ja vem com downloadUrl publica (e com marca d'agua, do
 * backfill v5.171-187). Fotos do Drive viram URL do CDN lh3 — validado em
 * 04/08/2026 que abrem sem nenhuma sessao Google, mesmo caminho que o site
 * estatico seuimovelnarepresa.com.br ja usa em producao.
 *
 * O driveFileId nunca entra na resposta: so a URL montada vai pro catalogo.
 */
function urlFoto(m, largura) {
  if (!m) return null;
  if (m.downloadUrl) return String(m.downloadUrl);
  if (m.driveFileId) return 'https://lh3.googleusercontent.com/d/' + m.driveFileId + '=w' + largura;
  return null;
}

/**
 * Converte um doc de properties no objeto publico. Devolve null se o imovel
 * nao pode ser publicado.
 *
 * WHITELIST EXPLICITA — nada entra que nao esteja escrito nome por nome aqui.
 * Deliberadamente de fora: ownerName, ownerPhone, ownerEmailContact,
 * ownerNotes, ownerEmail, submitterInfo (CPF/RG), authorizationAccepted,
 * commissionPayment, driveFolderId, media[].driveFileId, prevContact,
 * partnerFavoritedBy, sourceUrl, wpPostId, wpUrl, endereco, lat/lng exatos.
 */
function paraPublico(d) {
  if (!d) return null;

  // Rascunho, submissao pendente e submissao rejeitada nao saem.
  if (d.publishToSite !== true) return null;
  if (d.submissionStatus && d.submissionStatus !== 'approved') return null;

  const fotos = Array.isArray(d.media)
    ? d.media
        .filter((m) => m && String(m.type || '').startsWith('image/'))
        .map((m) => ({ url: urlFoto(m, LARGURA_FOTO), thumb: urlFoto(m, LARGURA_THUMB) }))
        .filter((f) => f.url)
    : [];

  return {
    codigo: d.codigo == null ? null : String(d.codigo),
    titulo: d.titulo || null,
    descricao: d.descricao || null,
    categoria: d.categoria || null,
    finalidade: d.finalidade || null,

    precoVenda: paraNumero(d.precoVenda),
    precoLocacao: paraNumero(d.precoLocacao),

    // Decisao 1: sem `endereco`, sem coordenada exata. Nunca, sem excecao.
    cidade: d.cidade || null,
    bairro: d.bairro || null,
    localizacaoAproximada: {
      lat: arredondaCoord(d.lat),
      lng: arredondaCoord(d.lng),
      precisaoMetros: 110,
    },

    quartos: paraInteiro(d.quartos),
    suites: paraInteiro(d.suites),
    banheiros: paraInteiro(d.banheiros),
    vagas: paraInteiro(d.vagas),
    areaTerreno: paraNumero(d.areaTerreno),
    areaConstr: paraNumero(d.areaConstr),

    recursos: Array.isArray(d.recursos) ? d.recursos.map(String) : [],
    aptoFinanciamento: d.aptoFinanciamento === true,
    dealStatus: d.dealStatus || 'disponivel',

    fotos,
    atualizadoEm: paraIso(d.updatedAt) || paraIso(d.createdAt),

    // Chaves de busca pre-normalizadas — removidas por limpar() antes de responder.
    _cidadeNorm: semAcento(d.cidade),
    _bairroNorm: semAcento(d.bairro),
  };
}

/** Remove os campos internos de normalizacao antes de responder. */
function limpar(it) {
  const copia = Object.assign({}, it);
  delete copia._cidadeNorm;
  delete copia._bairroNorm;
  return copia;
}

// ---------------------------------------------------------------------------
// Filtros e ordenacao
// ---------------------------------------------------------------------------

function aplicarFiltros(itens, q) {
  q = q || {};
  const cidade = semAcento(q.cidade);
  const bairro = semAcento(q.bairro);
  const categoria = semAcento(q.categoria);
  const finalidade = semAcento(q.finalidade);
  const precoMin = paraNumero(q.precoMin);
  const precoMax = paraNumero(q.precoMax);
  const quartosMin = paraInteiro(q.quartosMin);
  const recursos = String(q.recursos || '').split(',').map(semAcento).filter(Boolean);
  const desde = q.atualizadoDesde ? paraIso(q.atualizadoDesde) : null;
  const incluirIndisponiveis = String(q.incluirIndisponiveis || '') === 'true';

  // precoMin/precoMax batem no preco de venda, salvo em busca de locacao.
  const campoPreco = finalidade === 'locacao' ? 'precoLocacao' : 'precoVenda';

  return itens.filter((it) => {
    if (!incluirIndisponiveis && (it.dealStatus === 'vendido' || it.dealStatus === 'locado')) return false;
    if (cidade && it._cidadeNorm !== cidade) return false;
    if (bairro && it._bairroNorm !== bairro) return false;
    if (categoria && semAcento(it.categoria) !== categoria) return false;
    if (finalidade) {
      const f = semAcento(it.finalidade);
      if (f !== finalidade && f !== 'ambos') return false;
    }
    if (precoMin != null && !(it[campoPreco] != null && it[campoPreco] >= precoMin)) return false;
    if (precoMax != null && !(it[campoPreco] != null && it[campoPreco] <= precoMax)) return false;
    if (quartosMin != null && !(it.quartos != null && it.quartos >= quartosMin)) return false;
    if (q.aptoFinanciamento != null && q.aptoFinanciamento !== '') {
      if (it.aptoFinanciamento !== (String(q.aptoFinanciamento) === 'true')) return false;
    }
    if (q.dealStatus && semAcento(it.dealStatus) !== semAcento(q.dealStatus)) return false;
    if (recursos.length) {
      const meus = (it.recursos || []).map(semAcento);
      if (!recursos.every((r) => meus.includes(r))) return false;
    }
    if (desde && !(it.atualizadoEm && it.atualizadoEm >= desde)) return false;
    return true;
  });
}

function ordenar(itens, modo) {
  const copia = itens.slice();
  const preco = (it) => (it.precoVenda != null ? it.precoVenda : it.precoLocacao);
  if (modo === 'preco_asc') {
    copia.sort((a, b) => (preco(a) == null ? Infinity : preco(a)) - (preco(b) == null ? Infinity : preco(b)));
  } else if (modo === 'preco_desc') {
    copia.sort((a, b) => (preco(b) == null ? -Infinity : preco(b)) - (preco(a) == null ? -Infinity : preco(a)));
  }
  // Padrao: o catalogo ja vem ordenado por atualizadoEm desc.
  return copia;
}

module.exports = {
  CASAS_DECIMAIS_COORD,
  LARGURA_FOTO,
  LARGURA_THUMB,
  semAcento,
  paraNumero,
  paraInteiro,
  arredondaCoord,
  paraIso,
  urlFoto,
  paraPublico,
  limpar,
  aplicarFiltros,
  ordenar,
};
