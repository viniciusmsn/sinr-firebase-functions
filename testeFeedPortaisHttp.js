/**
 * Teste da Cloud Function feedPortais de ponta a ponta, com o Firestore trocado
 * por um de mentira.   node testeFeedPortaisHttp.js
 *
 * Carrega o feedPortais.js de verdade (o arquivo que sobe) e chama o handler que
 * ele registra no onRequest. So o firebase e substituido — rotas, token, cache,
 * cabecalhos e o XML sao os reais.
 */
const Module = require('module');
const path = require('path');
const crypto = require('crypto');

const TOKEN = crypto.randomBytes(24).toString('hex');
const HASH = crypto.createHash('sha256').update(TOKEN, 'utf8').digest('hex');
const REVOGADO = crypto.randomBytes(24).toString('hex');

const fotos = (n) => Array.from({ length: n }, (_, i) => ({ type: 'image/jpeg', name: i + '.jpg', driveFileId: 'drv' + i }));
const PROPS = [
  { publishToSite: true, codigo: 'A1', slug: 'casa-a1', titulo: 'Casa com piscina no Enseada Azul', categoria: 'casa', finalidade: 'venda',
    descricao: 'Casa ampla com piscina e area gourmet, a poucos metros da represa Jurumirim.', precoVenda: 900000,
    cidade: 'Paranapanema', bairro: 'Enseada Azul', quartos: 3, banheiros: 2, areaConstr: 200, areaTerreno: 800, media: fotos(6),
    ownerName: 'Fulano Proprietario', ownerPhone: '+5514999990000', endereco: 'Rua Secreta 100' },
  { publishToSite: true, codigo: 'A2', titulo: 'Terreno sem fotos suficientes', categoria: 'terreno', finalidade: 'venda',
    descricao: 'Terreno plano em condominio fechado, pronto para construir sua casa.', precoVenda: 100000,
    cidade: 'Paranapanema', bairro: 'Enseada Azul', areaTerreno: 500, media: fotos(2) },
];
const estado = {
  config: { contato: { nome: 'Seu Imovel na Represa', email: 'contato@exemplo.com.br' } },
  tokens: { bom: { hash: HASH, ativo: true }, velho: { hash: crypto.createHash('sha256').update(REVOGADO).digest('hex'), ativo: false } },
};
let leiturasProps = 0;
let leiturasToken = 0;
let camposSelect = null;
const gravacoes = [];

const db = {
  doc: (c) => ({ get: async () => ({ exists: c === 'feed_portais/config' && !!estado.config, data: () => estado.config }) }),
  collection: (nome) => {
    if (nome === 'properties') {
      return { where: () => ({ select: (...campos) => { camposSelect = campos; return { get: async () => {
        leiturasProps++;
        // fiel ao Firestore: so devolve os campos pedidos no select()
        return { docs: PROPS.map((p) => ({ data: () => Object.fromEntries(Object.entries(p).filter(([k]) => campos.includes(k))) })) };
      } }; } }) };
    }
    return {
      where: (_c, _o, v) => ({ limit: () => ({ get: async () => {
        leiturasToken++;
        const a = Object.entries(estado.tokens).filter(([, t]) => t.hash === v);
        return { empty: !a.length, docs: a.map(([id, t]) => ({ id, data: () => t })) };
      } }) }),
      doc: (id) => ({ set: async (v) => { gravacoes.push([id, v]); } }),
    };
  },
};

let handler = null; let opcoesFn = null;
const stubs = {
  'firebase-functions/v2/https': { onRequest: (o, h) => { opcoesFn = o; handler = h; return {}; } },
  'firebase-functions': { logger: { info() {}, warn() {}, error(m, d) { console.log('   [logger.error]', m, d && d.err); } } },
  'firebase-admin': { apps: [{}], initializeApp() {}, firestore: Object.assign(() => db, { FieldValue: { increment: (n) => ({ inc: n }) } }) },
};
const original = Module._load;
Module._load = function (req) { return stubs[req] || original.apply(this, arguments); };
require(path.join(__dirname, 'feedPortais.js'));
Module._load = original;

async function chamar(metodo, caminho, ua) {
  const r = { status: 0, corpo: null, headers: {} };
  const res = {
    set: (k, v) => { r.headers[k] = v; return res; },
    status: (s) => { r.status = s; return res; },
    type: (t) => { r.headers['Content-Type'] = r.headers['Content-Type'] || t; return res; },
    json: (j) => { r.corpo = j; return res; },
    send: (s) => { r.corpo = s; return res; },
  };
  await handler({ method: metodo, path: caminho, query: {}, get: (h) => (h === 'User-Agent' ? ua : undefined) }, res);
  return r;
}

let passou = 0; let falhou = 0;
function ok(c, nome, det) { if (c) { passou++; console.log('  ok   ' + nome); } else { falhou++; console.log('  FALHA ' + nome + (det ? ' -> ' + det : '')); } }
function igual(a, b, nome) { ok(JSON.stringify(a) === JSON.stringify(b), nome, 'veio ' + JSON.stringify(a)); }

(async () => {
  console.log('\n== Quem nao tem a URL nao descobre nada ==');
  igual((await chamar('GET', '/')).status, 404, 'raiz -> 404');
  igual((await chamar('GET', '/vrsync/')).status, 404, 'sem token -> 404');
  igual((await chamar('GET', '/vrsync/' + 'x'.repeat(48) + '.xml')).status, 404, 'token inexistente -> 404 (nao 401: nao confirma que o endpoint existe)');
  igual((await chamar('GET', '/vrsync/' + REVOGADO + '.xml')).status, 404, 'token revogado -> 404');
  const antes = leiturasToken;
  await chamar('GET', '/vrsync/abc.xml'); await chamar('GET', '/vrsync/' + encodeURIComponent('../../x') + '.xml');
  igual(leiturasToken, antes, 'token fora do formato nem consulta o banco');
  igual((await chamar('POST', '/vrsync/' + TOKEN + '.xml')).status, 405, 'POST -> 405');
  igual(leiturasProps, 0, 'nenhuma dessas tentativas leu imovel');

  console.log('\n== O XML ==');
  const r = await chamar('GET', '/vrsync/' + TOKEN + '.xml', 'VivaRealBot/1.0 (+http://www.vivareal.com/bot.html)');
  igual(r.status, 200, 'token valido -> 200');
  igual(r.headers['Content-Type'], 'application/xml; charset=utf-8', 'Content-Type XML UTF-8');
  igual(r.headers['Cache-Control'], 'no-store', 'URL secreta: sem cache em intermediario');
  ok(/noindex/.test(r.headers['X-Robots-Tag']), 'noindex');
  ok(r.corpo.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'comeca pela declaracao XML');
  igual((r.corpo.match(/<Listing>/g) || []).length, 1, 'so o imovel que passa nas regras');
  ok(r.corpo.indexOf('<ListingID>A1</ListingID>') !== -1 && r.corpo.indexOf('A2') === -1, 'A1 entra, A2 (2 fotos) nao');
  ok(r.corpo.indexOf('Fulano') === -1 && r.corpo.indexOf('Rua Secreta') === -1 && r.corpo.indexOf('5514999990000') === -1, 'nada do proprietario no XML');
  ok(!camposSelect.includes('endereco') && !camposSelect.some((c) => /^owner/.test(c)), 'o select() nem pede endereco ou owner* ao banco');
  igual((await chamar('GET', '/feedPortais/vrsync/' + TOKEN + '.xml')).status, 200, 'aceita o prefixo /feedPortais');
  const head = await chamar('HEAD', '/vrsync/' + TOKEN + '.xml');
  igual([head.status, head.corpo], [200, ''], 'HEAD responde 200 sem corpo');

  console.log('\n== Relatorio ==');
  const rel = await chamar('GET', '/relatorio/' + TOKEN);
  igual([rel.status, rel.corpo.incluidos, rel.corpo.excluidos.length], [200, 1, 1], 'relatorio: 1 entra, 1 fica de fora');
  ok(/menos de 5 fotos/.test(rel.corpo.excluidos[0].motivos[0]), 'com o motivo');
  igual((await chamar('GET', '/relatorio/' + 'y'.repeat(48))).status, 404, 'relatorio tambem exige token');

  console.log('\n== Cache e registro de leitura ==');
  igual(leiturasProps, 1, '5 respostas, 1 leitura dos imoveis (cache de instancia)');
  igual(gravacoes.length, 1, 'leitura registrada uma vez, nao a cada request');
  igual([gravacoes[0][0], gravacoes[0][1].ultimoUserAgent, gravacoes[0][1].ultimoTotalAnuncios], ['bom', 'VivaRealBot/1.0 (+http://www.vivareal.com/bot.html)', 1], 'registro guarda quem leu e quantos anuncios');
  igual(opcoesFn.cors, false, 'sem CORS: navegador de terceiro nao le');

  console.log('\n== Mudanca de config vale na hora, sem esperar o cache ==');
  estado.config = Object.assign({}, estado.config, { modo: 'marcados', atualizadoEm: '2026-11-16T12:00:00Z' });
  const m = await chamar('GET', '/vrsync/' + TOKEN + '.xml');
  igual([m.status, (m.corpo.match(/<Listing>/g) || []).length], [200, 0], 'modo "marcados" sem ninguem marcado: feed valido e vazio, na requisicao seguinte');
  igual(leiturasProps, 2, 'config nova forca nova geracao');
  PROPS[0].publishToPortais = true;
  estado.config = Object.assign({}, estado.config, { atualizadoEm: '2026-11-16T12:05:00Z' });
  igual(((await chamar('GET', '/vrsync/' + TOKEN + '.xml')).corpo.match(/<ListingID>A1</g) || []).length, 1, 'imovel marcado entra');
  estado.config = Object.assign({}, estado.config, { ativo: false, atualizadoEm: '2026-11-16T12:10:00Z' });
  igual((await chamar('GET', '/vrsync/' + TOKEN + '.xml')).status, 503, '--ativo nao: 503 imediato (botao de emergencia)');
  igual((await chamar('GET', '/relatorio/' + TOKEN)).status, 200, 'o relatorio continua acessivel com o feed desligado');
  estado.config = { atualizadoEm: '2026-11-16T12:15:00Z' };
  const semContato = await chamar('GET', '/vrsync/' + TOKEN + '.xml');
  ok(semContato.status === 503 && /contato nao configurado/.test(semContato.corpo), 'sem contato configurado: 503 explicando o que falta');

  console.log('\n' + (falhou === 0 ? 'TODOS OS ' + passou + ' TESTES HTTP PASSARAM' : falhou + ' FALHA(S) de ' + (passou + falhou)));
  process.exit(falhou === 0 ? 0 : 1);
})();
