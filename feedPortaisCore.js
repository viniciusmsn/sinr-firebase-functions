/**
 * Feed de portais (ZAP, VivaReal e OLX via Canal Pro) — logica pura.
 *
 * Gera o XML no padrao VRSync a partir dos docs de `properties`.
 * Especificacao: https://developers.grupozap.com/feeds/vrsync/ (lida em 16/11/2026).
 *
 * Sem dependencia de firebase, de proposito: e este arquivo que decide o que
 * vai parar num anuncio publico, entao precisa ser testavel sozinho
 * (`node testeFeedPortais.js`).
 *
 * Este arquivo NAO exporta Cloud Functions. Nao entra no Object.assign do index.js.
 *
 * Regras do portal que derrubam anuncio (cada uma vira um motivo no relatorio):
 *   - CEP obrigatorio em todo anuncio
 *   - minimo de 5 fotos, so JPG
 *   - titulo de 10 a 100 caracteres, descricao de 50 a 3000
 *   - casa/chacara exigem quartos e banheiros; casa exige area util;
 *     terreno e chacara exigem area total
 *   - preco inteiro conforme a finalidade
 *
 * Endereco: segue a decisao de 04/08/2026 — rua e numero NUNCA saem. O anuncio
 * leva cidade, bairro, CEP do bairro e coordenada arredondada (~110 m), com
 * displayAddress="Neighborhood".
 */

const NS = 'http://www.vivareal.com/schemas/1.0/VRSync';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const SCHEMA_LOCATION = NS + ' http://xml.vivareal.com/vrsync.xsd';

const TITULO_MIN = 10;
const TITULO_MAX = 100;
const DESCRICAO_MIN = 50;
const DESCRICAO_MAX = 3000;
const FOTOS_MIN = 5;
const FOTOS_MAX = 50;          // a doc nao da teto; os exemplos tem 25-30. Teto nosso.
const LISTING_ID_MAX = 50;
const LARGURA_FOTO = 1600;
const CASAS_COORD = 3;         // ~110 m, igual a API de parceiros
const LIMITE_FEED = 50000;     // teto de anuncios por arquivo, da doc

const PUBLICATION_TYPES = ['STANDARD', 'PREMIUM', 'SUPER_PREMIUM', 'PREMIERE_1', 'PREMIERE_2', 'TRIPLE'];

const SITE_BASE = 'https://seuimovelnarepresa.com.br';

/**
 * CEP representativo por cidade|bairro (chave normalizada por chaveLugar()).
 *
 * So entram aqui os bairros cujo nome no cadastro bate EXATAMENTE com o nome
 * na base dos Correios (conferido no ViaCEP em 16/11/2026). O resto vem da
 * config (`feed_portais/config.cepPorBairro`), porque exige alguem que conheca
 * a regiao: "Riviera de Santa Cristina XIII", por exemplo, nos Correios e
 * "Terras de Santa Cristina XIII Setor Marina" ou "Setor Iate".
 *
 * Estas cidades NAO tem mais CEP unico — o antigo xxxxx-000 nao existe mais
 * na base dos Correios.
 */
const CEP_PADRAO = {
  'avare|o estribo': '18709-050',
  'avare|ponta dos cambaras': '18709-600',
  'paranapanema|enseada azul': '18727-600',
  'paranapanema|terras de santa cristina v': '18723-500',
  'paranapanema|centro': '18720-031',
  'arandu|riviera de santa cristina i': '18715-000',
  'arandu|riviera de santa cristina iv': '18716-000',
  'itai|riviera de santa cristina ii': '18739-500',
  'itai|riviera de santa cristina iii': '18737-500',
  'pardinho|ninho verde ii': '18645-030',
};

/**
 * recursos[] do CRM -> <Feature> do VRSync. So valores da tabela oficial.
 * Sem equivalente fiel (ficam so na descricao): condominio (vira o tipo
 * "Casa de Condominio"), pier, rampa, fire_pit.
 */
const FEATURES = {
  portaria_24h: 'Concierge 24h',
  churrasqueira: 'BBQ',
  piscina: 'Pool',
  mobiliado: 'Furnished',
  vista_represa: 'Lake View',
  wifi: 'Internet Connection',
  energia_fotovoltaica: 'Solar Energy',
  energia_solar: 'Solar Energy',
  aquecimento_piscina: 'Heated Pool',
  pomar: 'Pomar',
  pet_friendly: 'Pets Allowed',
  boiler: 'Heating',
  quadra: 'Sports Court',
  poco: 'Well',
  campo_futebol: 'Football Field',
};

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

/** Chave de lugar: "cidade|bairro", sem acento, minusculo, espacos colapsados. */
function chaveLugar(cidade, bairro) {
  const n = (s) => semAcento(s).replace(/\s+/g, ' ');
  return n(cidade) + '|' + n(bairro);
}

/** Aceita number, "850000", "850.000,00" e "R$ 850.000". Devolve number ou null. */
function paraNumero(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v).replace(/[^\d,.-]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

/** Inteiro positivo ou null (o portal so aceita inteiro, sem casas). */
function inteiroPositivo(v) {
  const n = paraNumero(v);
  if (n == null) return null;
  const i = Math.round(n);
  return i > 0 ? i : null;
}

/** Inteiro >= 0 ou null. */
function inteiroNaoNegativo(v) {
  const n = paraNumero(v);
  if (n == null) return null;
  const i = Math.trunc(n);
  return i >= 0 ? i : null;
}

function arredondaCoord(v) {
  const n = paraNumero(v);
  if (n == null) return null;
  const f = Math.pow(10, CASAS_COORD);
  return Math.round(n * f) / f;
}

function normalizaCep(v) {
  const digitos = String(v == null ? '' : v).replace(/\D/g, '');
  return digitos.length === 8 ? digitos.slice(0, 5) + '-' + digitos.slice(5) : null;
}

/** Texto limpo: sem tag HTML, sem caractere invalido em XML, espacos colapsados. */
function limpaTexto(s, manterQuebras) {
  let t = String(s == null ? '' : s)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*p\s*>/gi, '\n')
    // so o que tem cara de tag: "terreno < 500 m2 e > 300" precisa sobreviver
    .replace(/<\/?[a-zA-Z][^<>]{0,200}>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    // invalidos em XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
    // substitutos soltos (emoji cortado no meio)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  if (manterQuebras) {
    t = t.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  } else {
    t = t.replace(/\s+/g, ' ');
  }
  return t.trim();
}

/** Corta em `max` caracteres sem partir palavra (nem par substituto). */
function cortaEmPalavra(s, max) {
  if (s.length <= max) return s;
  let c = s.slice(0, max);
  const ultimoEspaco = c.search(/\s\S*$/);
  if (ultimoEspaco > max * 0.6) c = c.slice(0, ultimoEspaco);
  c = c.replace(/[\uD800-\uDBFF]$/, '');
  return c.replace(/[\s,;:.\-–—]+$/, '');
}

// ---------------------------------------------------------------------------
// XML
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(s) {
  return '<![CDATA[' + String(s == null ? '' : s).replace(/]]>/g, ']]]]><![CDATA[>') + ']]>';
}

// ---------------------------------------------------------------------------
// Mapeamentos
// ---------------------------------------------------------------------------

/**
 * categoria do CRM -> tipo do portal + o que ele exige.
 * Fonte das exigencias: tabelas de Bedrooms/Bathrooms e regra de areas da
 * pagina "Details" da doc.
 */
function tipoImovel(d) {
  const cat = semAcento(d.categoria);
  const emCondominio = Array.isArray(d.recursos) && d.recursos.map(semAcento).includes('condominio');
  const casa = {
    usageType: 'Residential',
    propertyType: emCondominio ? 'Residential / Condo' : 'Residential / Home',
    exigeQuartos: true, exigeBanheiros: true, exigeAreaUtil: true, exigeAreaTotal: false,
  };
  switch (cat) {
    case 'casa':
    case 'obra':
      return casa;
    case 'apartamento':
      return Object.assign({}, casa, { propertyType: 'Residential / Apartment' });
    case 'terreno':
      return {
        usageType: 'Residential', propertyType: 'Residential / Land Lot',
        exigeQuartos: false, exigeBanheiros: false, exigeAreaUtil: false, exigeAreaTotal: true,
      };
    case 'chacara':
      // "Agricultural" aparece nos filtros dos dois portais; "Farm Ranch" so no VivaReal.
      return {
        usageType: 'Residential', propertyType: 'Residential / Agricultural',
        exigeQuartos: true, exigeBanheiros: true, exigeAreaUtil: false, exigeAreaTotal: true,
      };
    case 'comercial':
      return {
        usageType: 'Commercial', propertyType: 'Commercial / Building',
        exigeQuartos: false, exigeBanheiros: false, exigeAreaUtil: true, exigeAreaTotal: false,
      };
    default:
      return null;
  }
}

function urlFoto(m) {
  if (!m) return null;
  const tipo = String(m.type || '').toLowerCase();
  const nome = String(m.name || '').toLowerCase();
  if (tipo && !tipo.startsWith('image/')) return null;
  if (!tipo && !/\.(jpe?g|png|webp|heic)$/.test(nome)) return null;
  if (m.driveFileId) {
    // "-rj" pede JPEG ao CDN do Google, qualquer que seja o original. O portal so importa JPG.
    return 'https://lh3.googleusercontent.com/d/' + m.driveFileId + '=w' + LARGURA_FOTO + '-rj';
  }
  if (m.downloadUrl) {
    // Storage entrega o arquivo como esta: so serve se ja for JPG.
    const ehJpg = tipo === 'image/jpeg' || tipo === 'image/jpg' || (!tipo && /\.jpe?g$/.test(nome));
    return ehJpg ? String(m.downloadUrl) : null;
  }
  return null;
}

function urlYoutube(links) {
  if (!Array.isArray(links)) return null;
  for (const l of links) {
    const s = String(l || '').trim();
    if (/^https:\/\/(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]{6,}/i.test(s)) return s;
  }
  return null;
}

function resolveCep(d, cfg) {
  const proprio = normalizaCep(d.cep);
  if (proprio) return proprio;
  const k = chaveLugar(d.cidade, d.bairro);
  const daConfig = cfg && cfg.cepPorBairro ? normalizaCep(cfg.cepPorBairro[k]) : null;
  return daConfig || normalizaCep(CEP_PADRAO[k]);
}

// ---------------------------------------------------------------------------
// Doc -> anuncio
// ---------------------------------------------------------------------------

/** O imovel pode aparecer em portal? (publicado, aprovado, disponivel, nao barrado) */
function elegivel(d, cfg) {
  if (!d || d.publishToSite !== true) return 'nao publicado no site';
  if (d.submissionStatus && d.submissionStatus !== 'approved') return 'submissao nao aprovada';
  if (d.dealStatus === 'vendido' || d.dealStatus === 'locado') return 'vendido ou locado';
  const modo = cfg && cfg.modo === 'marcados' ? 'marcados' : 'todos';
  if (modo === 'marcados' && d.publishToPortais !== true) return 'nao marcado para portais';
  if (d.publishToPortais === false) return 'retirado dos portais no cadastro';
  return null;
}

/**
 * Converte um doc de properties num anuncio validado.
 * Devolve { ok:true, anuncio, avisos } ou { ok:false, id, motivos }.
 *
 * WHITELIST: so entra no anuncio o que esta escrito aqui, nome por nome.
 * Nunca leem-se owner*, submitterInfo, authorizationAccepted, endereco,
 * commissionPayment, driveFolderId nem nada de contato do proprietario.
 */
function montarAnuncio(d, cfg) {
  cfg = cfg || {};
  const motivos = [];
  const avisos = [];

  const id = String(d.codigo == null ? '' : d.codigo).trim().slice(0, LISTING_ID_MAX);
  if (!id) motivos.push('sem codigo');

  // --- titulo
  let titulo = limpaTexto(d.titulo, false);
  if (titulo.length > TITULO_MAX) {
    titulo = cortaEmPalavra(titulo, TITULO_MAX);
    avisos.push('titulo cortado em ' + TITULO_MAX + ' caracteres');
  }
  if (titulo.length < TITULO_MIN) motivos.push('titulo com menos de ' + TITULO_MIN + ' caracteres');

  // --- descricao
  let descricao = limpaTexto(d.descricao, true);
  if (descricao.length > DESCRICAO_MAX) {
    descricao = cortaEmPalavra(descricao, DESCRICAO_MAX);
    avisos.push('descricao cortada em ' + DESCRICAO_MAX + ' caracteres');
  }
  if (!descricao) motivos.push('sem descricao');
  else if (descricao.length < DESCRICAO_MIN) motivos.push('descricao com menos de ' + DESCRICAO_MIN + ' caracteres');

  // --- tipo
  const tipo = tipoImovel(d);
  if (!tipo) motivos.push('categoria sem tipo de portal: ' + (d.categoria || '(vazia)'));

  // --- finalidade e preco
  const fin = semAcento(d.finalidade);
  const venda = inteiroPositivo(d.precoVenda);
  const locacao = inteiroPositivo(d.precoLocacao);
  let transacao = null;
  if (fin === 'venda') {
    if (venda) transacao = 'For Sale'; else motivos.push('venda sem preco');
  } else if (fin === 'locacao') {
    if (locacao) transacao = 'For Rent'; else motivos.push('locacao sem preco');
  } else if (fin === 'ambos') {
    if (venda && locacao) transacao = 'Sale/Rent';
    else if (venda) { transacao = 'For Sale'; avisos.push('"ambos" sem preco de locacao: anunciado so para venda'); }
    else if (locacao) { transacao = 'For Rent'; avisos.push('"ambos" sem preco de venda: anunciado so para locacao'); }
    else motivos.push('sem preco');
  } else {
    motivos.push('finalidade invalida: ' + (d.finalidade || '(vazia)'));
  }

  // --- comodos e areas
  const quartos = inteiroNaoNegativo(d.quartos);
  const banheiros = inteiroNaoNegativo(d.banheiros);
  const suites = inteiroNaoNegativo(d.suites);
  const vagas = inteiroNaoNegativo(d.vagas);
  const areaUtil = inteiroPositivo(d.areaConstr);
  const areaTotal = inteiroPositivo(d.areaTerreno);
  if (tipo) {
    if (tipo.exigeQuartos && !quartos) motivos.push('sem quartos (obrigatorio para ' + tipo.propertyType + ')');
    if (tipo.exigeBanheiros && !banheiros) motivos.push('sem banheiros (obrigatorio para ' + tipo.propertyType + ')');
    if (tipo.exigeAreaUtil && !areaUtil) motivos.push('sem area construida (obrigatoria para ' + tipo.propertyType + ')');
    if (tipo.exigeAreaTotal && !areaTotal) motivos.push('sem area do terreno (obrigatoria para ' + tipo.propertyType + ')');
  }

  // --- localizacao
  const cidade = limpaTexto(d.cidade, false);
  const bairro = limpaTexto(d.bairro, false);
  if (!cidade) motivos.push('sem cidade');
  if (!bairro) motivos.push('sem bairro');
  const cep = resolveCep(d, cfg);
  if (!cep && cidade && bairro) motivos.push('sem CEP para ' + bairro + ' / ' + cidade);
  const uf = /^[A-Za-z]{2}$/.test(String(d.uf || '')) ? String(d.uf).toUpperCase() : (cfg.ufPadrao || 'SP');

  // --- fotos
  const midias = Array.isArray(d.media) ? d.media : [];
  const candidatas = midias.filter((m) => m && (String(m.type || '').startsWith('image/') || (!m.type && m.name)));
  const vistas = new Set();
  const fotos = [];
  candidatas.forEach((m) => {
    const u = urlFoto(m);
    if (u && !vistas.has(u)) { vistas.add(u); fotos.push(u); }
  });
  const descartadas = candidatas.length - fotos.length;
  if (descartadas > 0) avisos.push(descartadas + ' foto(s) fora do padrao do portal (so JPG)');
  // A doc diz "todos os anuncios devem conter no minimo 5 imagens", mas nao diz o
  // que o portal faz com quem tem menos. Padrao = a regra; cfg.fotosMinimas afrouxa.
  const minFotos = Math.max(1, inteiroPositivo(cfg.fotosMinimas) || FOTOS_MIN);
  if (fotos.length < minFotos) {
    motivos.push('menos de ' + minFotos + ' fotos (tem ' + fotos.length + ')');
  }
  if (fotos.length > FOTOS_MAX) {
    avisos.push('so as ' + FOTOS_MAX + ' primeiras fotos vao (tem ' + fotos.length + ')');
    fotos.length = FOTOS_MAX;
  }

  if (motivos.length) return { ok: false, id: id || '(sem codigo)', motivos, avisos };

  const features = [];
  (Array.isArray(d.recursos) ? d.recursos : []).forEach((r) => {
    const f = FEATURES[semAcento(r)];
    if (f && !features.includes(f)) features.push(f);
  });

  const publicationType = PUBLICATION_TYPES.includes(d.portaisDestaque)
    ? d.portaisDestaque
    : (PUBLICATION_TYPES.includes(cfg.publicationType) ? cfg.publicationType : 'STANDARD');

  const slug = String(d.slug || '').trim();

  return {
    ok: true,
    avisos,
    anuncio: {
      id,
      titulo,
      descricao,
      transacao,
      publicationType,
      // Com a barra no fim: sem ela o site responde 308 (conferido em 16/11/2026).
      url: /^[a-z0-9][a-z0-9-]*$/i.test(slug) ? SITE_BASE + '/imoveis/' + slug + '/' : null,
      fotos,
      video: urlYoutube(d.videoLinks),
      usageType: tipo.usageType,
      propertyType: tipo.propertyType,
      precoVenda: transacao === 'For Rent' ? null : venda,
      precoLocacao: transacao === 'For Sale' ? null : locacao,
      areaTotal,
      areaUtil,
      quartos,
      banheiros,
      suites,
      vagas,
      features,
      cidade,
      bairro,
      uf,
      cep,
      lat: arredondaCoord(d.lat),
      lng: arredondaCoord(d.lng),
      atualizadoEm: carimbo(d.updatedAt) || carimbo(d.createdAt) || 0,
    },
  };
}

function carimbo(v) {
  if (!v) return 0;
  try {
    if (typeof v.toMillis === 'function') return v.toMillis();
    if (typeof v.toDate === 'function') return v.toDate().getTime();
    if (v instanceof Date) return v.getTime() || 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
    const t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  } catch (_) { return 0; }
}

// ---------------------------------------------------------------------------
// Anuncio -> XML
// ---------------------------------------------------------------------------

const NOMES_UF = { SP: 'São Paulo', PR: 'Paraná', MG: 'Minas Gerais', RJ: 'Rio de Janeiro', MS: 'Mato Grosso do Sul' };

function xmlContato(c) {
  const l = ['      <ContactInfo>',
    '        <Name>' + cdata(c.nome) + '</Name>',
    '        <Email>' + esc(c.email) + '</Email>'];
  if (c.site) l.push('        <Website>' + esc(c.site) + '</Website>');
  if (c.telefone) l.push('        <Telephone>' + esc(c.telefone) + '</Telephone>');
  l.push('      </ContactInfo>');
  return l.join('\n');
}

/** Ordem dos elementos igual a dos exemplos oficiais. */
function xmlAnuncio(a, contato) {
  const l = [];
  l.push('    <Listing>');
  l.push('      <ListingID>' + esc(a.id) + '</ListingID>');
  l.push('      <Title>' + cdata(a.titulo) + '</Title>');
  l.push('      <TransactionType>' + a.transacao + '</TransactionType>');
  l.push('      <PublicationType>' + a.publicationType + '</PublicationType>');
  if (a.url) l.push('      <DetailViewUrl>' + esc(a.url) + '</DetailViewUrl>');

  l.push('      <Media>');
  if (a.video) l.push('        <Item medium="video">' + esc(a.video) + '</Item>');
  a.fotos.forEach((u, i) => {
    l.push('        <Item medium="image" caption="img' + (i + 1) + '"' + (i === 0 ? ' primary="true"' : '') + '>' + esc(u) + '</Item>');
  });
  l.push('      </Media>');

  l.push('      <Details>');
  l.push('        <UsageType>' + a.usageType + '</UsageType>');
  l.push('        <PropertyType>' + a.propertyType + '</PropertyType>');
  // A doc pede quebra de linha como <br> escapado; dentro de CDATA ele vai literal.
  l.push('        <Description>' + cdata(a.descricao.replace(/\n/g, '<br>')) + '</Description>');
  if (a.precoVenda) l.push('        <ListPrice currency="BRL">' + a.precoVenda + '</ListPrice>');
  if (a.precoLocacao) l.push('        <RentalPrice currency="BRL" period="Monthly">' + a.precoLocacao + '</RentalPrice>');
  if (a.areaTotal) l.push('        <LotArea unit="square metres">' + a.areaTotal + '</LotArea>');
  if (a.areaUtil) l.push('        <LivingArea unit="square metres">' + a.areaUtil + '</LivingArea>');
  if (a.quartos != null) l.push('        <Bedrooms>' + a.quartos + '</Bedrooms>');
  if (a.banheiros != null) l.push('        <Bathrooms>' + a.banheiros + '</Bathrooms>');
  if (a.suites != null) l.push('        <Suites>' + a.suites + '</Suites>');
  if (a.vagas != null) l.push('        <Garage type="Parking Space">' + a.vagas + '</Garage>');
  if (a.features.length) {
    l.push('        <Features>');
    a.features.forEach((f) => l.push('          <Feature>' + esc(f) + '</Feature>'));
    l.push('        </Features>');
  }
  l.push('      </Details>');

  l.push('      <Location displayAddress="Neighborhood">');
  l.push('        <Country abbreviation="BR">Brasil</Country>');
  l.push('        <State abbreviation="' + esc(a.uf) + '">' + cdata(NOMES_UF[a.uf] || a.uf) + '</State>');
  l.push('        <City>' + cdata(a.cidade) + '</City>');
  l.push('        <Neighborhood>' + cdata(a.bairro) + '</Neighborhood>');
  l.push('        <PostalCode>' + esc(a.cep) + '</PostalCode>');
  if (a.lat != null && a.lng != null) {
    l.push('        <Latitude>' + a.lat + '</Latitude>');
    l.push('        <Longitude>' + a.lng + '</Longitude>');
  }
  l.push('      </Location>');

  l.push(xmlContato(contato));
  l.push('    </Listing>');
  return l.join('\n');
}

function contatoValido(cfg) {
  const c = (cfg && cfg.contato) || {};
  const nome = limpaTexto(c.nome, false);
  const email = String(c.email || '').trim();
  if (!nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return {
    nome,
    email,
    telefone: limpaTexto(c.telefone, false) || null,
    site: /^https?:\/\//.test(String(c.site || '')) ? String(c.site).trim() : null,
  };
}

/**
 * Gera o feed inteiro.
 *
 * @param docs  array de docs de properties (objetos puros)
 * @param cfg   { contato:{nome,email,telefone,site}, cepPorBairro, modo, limite, publicationType, ufPadrao }
 * @param agora Date da geracao
 * @return { xml, relatorio }  — xml e null se o contato nao estiver configurado
 */
function gerarFeed(docs, cfg, agora) {
  cfg = cfg || {};
  agora = agora || new Date();
  const contato = contatoValido(cfg);

  const relatorio = {
    geradoEm: agora.toISOString(),
    totalRecebidos: docs.length,
    foraDoEscopo: {},        // motivo -> quantos (nao publicado, vendido, ...)
    candidatos: 0,           // publicados e disponiveis
    incluidos: 0,
    excluidos: [],           // [{ codigo, motivos }]
    porMotivo: {},           // motivo generico -> quantos
    avisos: [],              // [{ codigo, avisos }]
    cortadosPeloLimite: [],  // codigos
    semCepPorBairro: {},     // "Bairro / Cidade" -> quantos
    erro: contato ? null : 'contato nao configurado (nome e e-mail sao obrigatorios no anuncio)',
  };

  const anuncios = [];
  const idsVistos = new Set();

  docs.forEach((d) => {
    const fora = elegivel(d, cfg);
    if (fora) { relatorio.foraDoEscopo[fora] = (relatorio.foraDoEscopo[fora] || 0) + 1; return; }
    relatorio.candidatos++;

    const r = montarAnuncio(d, cfg);
    if (r.ok && idsVistos.has(r.anuncio.id)) {
      r.ok = false; r.id = r.anuncio.id; r.motivos = ['codigo duplicado (o portal so processa um)'];
    }
    if (!r.ok) {
      relatorio.excluidos.push({ codigo: r.id, motivos: r.motivos });
      r.motivos.forEach((m) => {
        const generico = m.replace(/\(tem \d+\)/, '').replace(/^menos de \d+ fotos/, 'poucas fotos').replace(/^sem CEP para .*/, 'sem CEP para o bairro').replace(/\s*\(obrigatori[ao] para .*\)/, '').trim();
        relatorio.porMotivo[generico] = (relatorio.porMotivo[generico] || 0) + 1;
        const cepM = m.match(/^sem CEP para (.*)$/);
        if (cepM) relatorio.semCepPorBairro[cepM[1]] = (relatorio.semCepPorBairro[cepM[1]] || 0) + 1;
      });
      return;
    }
    idsVistos.add(r.anuncio.id);
    if (r.avisos.length) relatorio.avisos.push({ codigo: r.anuncio.id, avisos: r.avisos });
    anuncios.push(r.anuncio);
  });

  // Mais recentes primeiro: e quem fica quando ha limite contratado.
  anuncios.sort((a, b) => (b.atualizadoEm - a.atualizadoEm) || a.id.localeCompare(b.id));
  const limiteCfg = inteiroPositivo(cfg.limite);
  const limite = Math.min(limiteCfg || LIMITE_FEED, LIMITE_FEED);
  if (anuncios.length > limite) {
    relatorio.cortadosPeloLimite = anuncios.slice(limite).map((a) => a.id);
    anuncios.length = limite;
  }
  relatorio.incluidos = anuncios.length;
  relatorio.codigosIncluidos = anuncios.map((a) => a.id);

  if (!contato) return { xml: null, relatorio };

  const partes = [];
  partes.push('<?xml version="1.0" encoding="UTF-8"?>');
  partes.push('<ListingDataFeed xmlns="' + NS + '" xmlns:xsi="' + XSI + '" xsi:schemaLocation="' + SCHEMA_LOCATION + '">');
  partes.push('  <Header>');
  partes.push('    <Provider>' + cdata(contato.nome) + '</Provider>');
  partes.push('    <Email>' + esc(contato.email) + '</Email>');
  partes.push('    <ContactName>' + cdata(contato.nome) + '</ContactName>');
  partes.push('    <PublishDate>' + agora.toISOString().slice(0, 19) + '</PublishDate>');
  if (contato.telefone) partes.push('    <Telephone>' + esc(contato.telefone) + '</Telephone>');
  partes.push('  </Header>');
  partes.push('  <Listings>');
  anuncios.forEach((a) => partes.push(xmlAnuncio(a, contato)));
  partes.push('  </Listings>');
  partes.push('</ListingDataFeed>');
  partes.push('');

  return { xml: partes.join('\n'), relatorio };
}

/** Campos de properties que o feed le. Usado no select() para nem carregar o resto. */
const CAMPOS_LIDOS = [
  'publishToSite', 'submissionStatus', 'dealStatus', 'publishToPortais', 'portaisDestaque',
  'codigo', 'slug', 'titulo', 'descricao', 'categoria', 'finalidade',
  'precoVenda', 'precoLocacao', 'cidade', 'bairro', 'uf', 'cep', 'lat', 'lng',
  'quartos', 'suites', 'banheiros', 'vagas', 'areaTerreno', 'areaConstr',
  'recursos', 'media', 'videoLinks', 'updatedAt', 'createdAt',
];

module.exports = {
  CEP_PADRAO, FEATURES, CAMPOS_LIDOS, PUBLICATION_TYPES,
  TITULO_MIN, TITULO_MAX, DESCRICAO_MIN, DESCRICAO_MAX, FOTOS_MIN, FOTOS_MAX,
  semAcento, chaveLugar, paraNumero, inteiroPositivo, normalizaCep,
  limpaTexto, cortaEmPalavra, esc, cdata,
  tipoImovel, urlFoto, urlYoutube, resolveCep,
  elegivel, montarAnuncio, xmlAnuncio, contatoValido, gerarFeed,
};
