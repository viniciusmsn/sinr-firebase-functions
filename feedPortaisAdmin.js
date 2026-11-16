/**
 * Administracao do feed de portais (ZAP / VivaReal / OLX). Roda na SUA maquina,
 * de dentro desta pasta. Acha o JSON do service account sozinho (nesta pasta ou
 * na de cima), igual ao criarChaveParceiro.js.
 *
 *   node feedPortaisAdmin.js diagnostico
 *       Gera o feed a partir do banco e mostra quem entra, quem fica de fora e
 *       por que. Nao grava nada. Com --salvar arquivo.xml, salva o XML.
 *       Com --lista, imprime tambem o codigo de cada imovel excluido.
 *
 *   node feedPortaisAdmin.js configurar --nome "Seu Imovel na Represa" --email contato@dominio.com.br --telefone "(14) 99999-9999" --site https://seuimovelnarepresa.com.br
 *       Contato que aparece nos anuncios. Nome e e-mail sao obrigatorios no portal.
 *       Opcionais: --modo todos|marcados   --limite 100 (ou 0 pra tirar)   --ativo sim|nao
 *                  --fotos-minimas 5 (regra do portal)   --destaque STANDARD|PREMIUM|...
 *
 *   node feedPortaisAdmin.js cep "Paranapanema" "Riviera de Santa Cristina XIII" 18727-200
 *       CEP usado para todo imovel daquele bairro. Imovel com campo `cep` proprio
 *       usa o dele. `cep ... remover` apaga a entrada.
 *
 *   node feedPortaisAdmin.js marcar I08NI A05MI          poe imoveis no feed (modo "marcados")
 *   node feedPortaisAdmin.js desmarcar I08NI             tira
 *   node feedPortaisAdmin.js marcados                    quem esta marcado e se esta entrando
 *   node feedPortaisAdmin.js marcar --aptos              mostra todos os aptos sem marca; com --sim, marca
 *       Grava so o campo publishToPortais do imovel. Avisa se o marcado ainda
 *       nao passa nas regras do portal, e por que.
 *
 *   node feedPortaisAdmin.js criar-url "Canal Pro"
 *       Cria a URL secreta do feed. Aparece UMA vez — e ela que voce cola no Canal Pro.
 *
 *   node feedPortaisAdmin.js listar            URLs criadas e quando o portal leu por ultimo
 *   node feedPortaisAdmin.js revogar <id>      desliga uma URL
 *   node feedPortaisAdmin.js config            mostra a configuracao atual
 */

const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const core = require('./feedPortaisCore');

const BASE = 'https://us-central1-seuimovelnarepresa.cloudfunctions.net/feedPortais';

function acharCredencial() {
  for (const dir of [__dirname, path.join(__dirname, '..')]) {
    let arquivos;
    try { arquivos = fs.readdirSync(dir); } catch (_) { continue; }
    const achado = arquivos.find((f) => /firebase-adminsdk.*\.json$/i.test(f));
    if (achado) return path.join(dir, achado);
  }
  return null;
}

function iniciar() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ projectId: 'seuimovelnarepresa' });
    return;
  }
  const cred = acharCredencial();
  if (!cred) {
    console.error('\nNao achei o JSON do service account (seuimovelnarepresa-firebase-adminsdk-*.json)');
    console.error('nesta pasta nem na de cima.\n');
    process.exit(1);
  }
  admin.initializeApp({ projectId: 'seuimovelnarepresa', credential: admin.credential.cert(require(cred)) });
}

function opcoes(args) {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const prox = args[i + 1];
      if (prox == null || prox.startsWith('--')) o[args[i].slice(2)] = true;
      else { o[args[i].slice(2)] = prox; i++; }
    } else o._.push(args[i]);
  }
  return o;
}

const refConfig = () => admin.firestore().doc('feed_portais/config');
const colTokens = () => admin.firestore().collection('feed_portais_tokens');

async function lerConfig() {
  const s = await refConfig().get();
  return s.exists ? s.data() : {};
}

// ---------------------------------------------------------------------------

async function diagnostico(o) {
  const db = admin.firestore();
  const cfg = await lerConfig();
  // Mesmo select() da function: o diagnostico ve exatamente o que ela ve.
  const snap = await db.collection('properties').where('publishToSite', '==', true).select(...core.CAMPOS_LIDOS).get();
  const docs = snap.docs.map((d) => d.data());
  const { xml, relatorio: r } = core.gerarFeed(docs, cfg, new Date());

  const linha = (a, b) => console.log('  ' + String(a).padEnd(46) + b);
  console.log('\n=== FEED DE PORTAIS — diagnostico ===\n');
  linha('Publicados no site', r.totalRecebidos);
  Object.entries(r.foraDoEscopo).forEach(([m, n]) => linha('  fora: ' + m, n));
  linha('Candidatos a anuncio', r.candidatos);
  linha('ENTRAM NO FEED', r.incluidos);
  linha('Ficam de fora por regra do portal', r.excluidos.length);
  if (r.cortadosPeloLimite.length) linha('Cortados pelo limite configurado', r.cortadosPeloLimite.length);

  if (Object.keys(r.porMotivo).length) {
    console.log('\nMotivos (um imovel pode ter mais de um):');
    Object.entries(r.porMotivo).sort((a, b) => b[1] - a[1]).forEach(([m, n]) => linha(m, n));
  }
  if (Object.keys(r.semCepPorBairro).length) {
    console.log('\nBairros sem CEP definido (resolva com: node feedPortaisAdmin.js cep "Cidade" "Bairro" 00000-000):');
    Object.entries(r.semCepPorBairro).sort((a, b) => b[1] - a[1]).forEach(([m, n]) => linha(m, n));
  }
  const soUmMotivo = {};
  r.excluidos.filter((e) => e.motivos.length === 1).forEach((e) => {
    const g = e.motivos[0].replace(/\(tem \d+\)/, '').replace(/^sem CEP para .*/, 'sem CEP para o bairro').replace(/\s*\(obrigatori[ao] para .*\)/, '').trim();
    soUmMotivo[g] = (soUmMotivo[g] || 0) + 1;
  });
  if (Object.keys(soUmMotivo).length) {
    console.log('\nA um passo de entrar (so falta UMA coisa):');
    Object.entries(soUmMotivo).sort((a, b) => b[1] - a[1]).forEach(([m, n]) => linha(m, n));
  }
  if (r.avisos.length) {
    const cont = {};
    r.avisos.forEach((a) => a.avisos.forEach((t) => { const g = t.replace(/\d+/g, 'N'); cont[g] = (cont[g] || 0) + 1; }));
    console.log('\nAjustes automaticos nos que entram:');
    Object.entries(cont).sort((a, b) => b[1] - a[1]).forEach(([m, n]) => linha(m, n));
  }
  if (o.lista) {
    console.log('\nExcluidos, um a um:');
    r.excluidos.sort((a, b) => a.codigo.localeCompare(b.codigo)).forEach((e) => console.log('  ' + e.codigo.padEnd(10) + e.motivos.join('; ')));
  }

  if (cfg.modo === 'marcados') {
    // No modo "marcados", mostra tambem quem entraria se fosse marcado.
    const aberto = core.gerarFeed(docs, Object.assign({}, cfg, { modo: 'todos', limite: null }), new Date()).relatorio;
    const jaEntram = new Set(r.codigosIncluidos);
    const esperando = aberto.codigosIncluidos.filter((c) => !jaEntram.has(c));
    console.log('\nModo "marcados": so entra imovel com publishToPortais = true.');
    linha('Marcados e aptos (estao no feed)', r.incluidos);
    linha('Aptos esperando voce marcar', esperando.length);
    linha('Marcados mas barrados por regra do portal', r.excluidos.length);
    if (o.lista && esperando.length) {
      console.log('\nAptos esperando marca (node feedPortaisAdmin.js marcar CODIGO ...):');
      for (let i = 0; i < esperando.length; i += 12) console.log('  ' + esperando.slice(i, i + 12).join(' '));
    }
  }

  if (r.erro) console.log('\nATENCAO: ' + r.erro + '\n  -> node feedPortaisAdmin.js configurar --nome "..." --email ...');
  if (xml) {
    console.log('\nXML: ' + (Buffer.byteLength(xml, 'utf8') / 1024).toFixed(0) + ' KB');
    if (typeof o.salvar === 'string') { fs.writeFileSync(o.salvar, xml, 'utf8'); console.log('salvo em ' + o.salvar); }
  }
  if (typeof o.json === 'string') fs.writeFileSync(o.json, JSON.stringify(r, null, 2), 'utf8');
  console.log('');
}

async function configurar(o) {
  const atual = await lerConfig();
  const contato = Object.assign({}, atual.contato);
  ['nome', 'email', 'telefone', 'site'].forEach((k) => { if (typeof o[k] === 'string') contato[k] = o[k].trim(); });
  const novo = { contato };

  if (o.modo != null) {
    if (o.modo !== 'todos' && o.modo !== 'marcados') { console.error('--modo aceita "todos" ou "marcados".'); process.exit(1); }
    novo.modo = o.modo;
  }
  if (o.limite != null) {
    const n = parseInt(o.limite, 10);
    if (isNaN(n) || n < 0) { console.error('--limite precisa ser um numero (0 tira o limite).'); process.exit(1); }
    novo.limite = n === 0 ? null : n;
  }
  if (o['fotos-minimas'] != null) {
    const n = parseInt(o['fotos-minimas'], 10);
    if (isNaN(n) || n < 1) { console.error('--fotos-minimas precisa ser 1 ou mais (a regra do portal e 5).'); process.exit(1); }
    novo.fotosMinimas = n;
  }
  if (o.ativo != null) novo.ativo = !/^(nao|não|false|0)$/i.test(String(o.ativo));
  if (o.destaque != null) {
    if (!core.PUBLICATION_TYPES.includes(o.destaque)) { console.error('--destaque aceita: ' + core.PUBLICATION_TYPES.join(', ')); process.exit(1); }
    novo.publicationType = o.destaque;
  }

  if (!core.contatoValido(novo)) {
    console.error('\nO portal exige nome e e-mail validos no anuncio. Informe --nome e --email.\n');
    process.exit(1);
  }
  novo.atualizadoEm = new Date().toISOString();
  await refConfig().set(novo, { merge: true });
  console.log('\nConfiguracao gravada. Vale na proxima leitura do feed.');
  await mostrarConfig();
}

/** Acha imoveis pelo campo `codigo` (sem diferenciar maiusculas). */
async function buscarPorCodigo(codigos) {
  const db = admin.firestore();
  const achados = new Map(); // CODIGO -> [docs]
  const alvo = [...new Set(codigos.map((c) => String(c).trim()).filter(Boolean))];
  const variantes = [...new Set(alvo.flatMap((c) => [c, c.toUpperCase(), c.toLowerCase()]))];
  for (let i = 0; i < variantes.length; i += 30) {
    const snap = await db.collection('properties').where('codigo', 'in', variantes.slice(i, i + 30)).get();
    snap.forEach((d) => {
      const k = String(d.data().codigo).toUpperCase();
      if (!achados.has(k)) achados.set(k, []);
      achados.get(k).push(d);
    });
  }
  return { alvo, achados };
}

async function marcar(o, valor) {
  const cfg = await lerConfig();
  let docsAlvo = [];

  if (o.aptos) {
    if (valor !== true) { console.error('--aptos so vale para "marcar".'); process.exit(1); }
    const snap = await admin.firestore().collection('properties').where('publishToSite', '==', true).get();
    snap.forEach((d) => {
      const x = d.data();
      if (x.publishToPortais === true) return;
      if (core.elegivel(x, { modo: 'todos' })) return;
      if (core.montarAnuncio(x, cfg).ok) docsAlvo.push(d);
    });
    if (!docsAlvo.length) { console.log('\nNenhum imovel apto sem marca.\n'); return; }
    if (!o.sim) {
      console.log('\n' + docsAlvo.length + ' imoveis aptos seriam marcados:');
      const cs = docsAlvo.map((d) => d.data().codigo);
      for (let i = 0; i < cs.length; i += 12) console.log('  ' + cs.slice(i, i + 12).join(' '));
      console.log('\nNada foi gravado. Para marcar todos: node feedPortaisAdmin.js marcar --aptos --sim\n');
      return;
    }
  } else {
    if (!o._.length) { console.error('Uso: node feedPortaisAdmin.js ' + (valor ? 'marcar' : 'desmarcar') + ' CODIGO [CODIGO ...]'); process.exit(1); }
    const { alvo, achados } = await buscarPorCodigo(o._);
    alvo.forEach((c) => {
      const ds = achados.get(c.toUpperCase());
      if (!ds) console.log('  ' + c.padEnd(10) + 'NAO ENCONTRADO');
      else if (ds.length > 1) console.log('  ' + c.padEnd(10) + 'codigo repetido em ' + ds.length + ' imoveis — nao mexi (o portal exige codigo unico)');
      else docsAlvo.push(ds[0]);
    });
  }

  for (const d of docsAlvo) {
    const x = d.data();
    // update(): so esse campo. Nao toca em updatedAt, pra nao reordenar o site nem o catalogo.
    await d.ref.update({ publishToPortais: valor });
    let obs = '';
    if (valor) {
      const fora = core.elegivel(Object.assign({}, x, { publishToPortais: true }), cfg);
      const r = fora ? null : core.montarAnuncio(x, cfg);
      if (fora) obs = '   (marcado, mas ainda nao entra: ' + fora + ')';
      else if (!r.ok) obs = '   (marcado, mas o portal barra: ' + r.motivos.join('; ') + ')';
    }
    console.log('  ' + String(x.codigo).padEnd(10) + (valor ? 'marcado' : 'desmarcado') + obs);
  }
  console.log('\n' + docsAlvo.length + ' imovel(is) ' + (valor ? 'marcado(s)' : 'desmarcado(s)') + '. O feed no ar reflete em ate 15 min; o portal le a cada 12 h.\n');
}

async function marcados() {
  const cfg = await lerConfig();
  const snap = await admin.firestore().collection('properties').where('publishToPortais', '==', true).get();
  if (snap.empty) { console.log('\nNenhum imovel marcado para portais.\n'); return; }
  console.log('');
  let entram = 0;
  snap.docs.map((d) => d.data()).sort((a, b) => String(a.codigo).localeCompare(String(b.codigo))).forEach((x) => {
    const fora = core.elegivel(x, cfg);
    const r = fora ? null : core.montarAnuncio(x, cfg);
    const situacao = fora ? 'FORA: ' + fora : (r.ok ? 'no feed' : 'BARRADO: ' + r.motivos.join('; '));
    if (!fora && r.ok) entram++;
    console.log('  ' + String(x.codigo).padEnd(10) + situacao);
  });
  console.log('\n' + snap.size + ' marcado(s), ' + entram + ' no feed.\n');
}

async function mostrarConfig() {
  const c = await lerConfig();
  const ct = c.contato || {};
  console.log('\nContato   : ' + (ct.nome || '(falta)') + ' | ' + (ct.email || '(falta)') + ' | ' + (ct.telefone || '-') + ' | ' + (ct.site || '-'));
  console.log('Modo      : ' + (c.modo === 'marcados' ? 'marcados (so imovel com publishToPortais = true)' : 'todos (publicados e disponiveis, menos publishToPortais = false)'));
  console.log('Limite    : ' + (c.limite ? c.limite + ' anuncios (os atualizados mais recentemente)' : 'sem limite'));
  console.log('Destaque  : ' + (c.publicationType || 'STANDARD'));
  console.log('Fotos min.: ' + (c.fotosMinimas || core.FOTOS_MIN) + (c.fotosMinimas && c.fotosMinimas < core.FOTOS_MIN ? '   (abaixo da regra do portal, que e ' + core.FOTOS_MIN + ')' : ''));
  console.log('Ativo     : ' + (c.ativo === false ? 'NAO' : 'sim'));
  const tab = Object.assign({}, core.CEP_PADRAO, c.cepPorBairro || {});
  console.log('CEPs por bairro (' + Object.keys(tab).length + '):');
  Object.keys(tab).sort().forEach((k) => console.log('  ' + k.padEnd(52) + tab[k] + ((c.cepPorBairro || {})[k] ? '' : '   (padrao do codigo)')));
  console.log('');
}

async function definirCep(o) {
  const [cidade, bairro, valor] = o._;
  if (!cidade || !bairro || !valor) { console.error('Uso: node feedPortaisAdmin.js cep "Cidade" "Bairro" 00000-000'); process.exit(1); }
  const chave = core.chaveLugar(cidade, bairro);
  // atualizadoEm muda em toda gravacao: e por ele que a function sabe que a config mudou.
  const agora = new Date().toISOString();
  if (valor === 'remover') {
    await refConfig().set({ cepPorBairro: { [chave]: admin.firestore.FieldValue.delete() }, atualizadoEm: agora }, { merge: true });
    console.log('Removido: ' + chave);
    return;
  }
  const cep = core.normalizaCep(valor);
  if (!cep) { console.error('CEP invalido: ' + valor + ' (precisa de 8 digitos).'); process.exit(1); }
  await refConfig().set({ cepPorBairro: { [chave]: cep }, atualizadoEm: agora }, { merge: true });
  console.log('Gravado: ' + chave + ' -> ' + cep);
}

async function criarUrl(o) {
  const nome = o._[0];
  if (!nome) { console.error('Uso: node feedPortaisAdmin.js criar-url "Canal Pro"'); process.exit(1); }
  const token = crypto.randomBytes(24).toString('hex'); // 48 hex: so [a-f0-9], seguro em URL
  const slug = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
  const id = (slug || 'feed') + '-' + crypto.randomBytes(3).toString('hex');
  await colTokens().doc(id).set({
    hash: crypto.createHash('sha256').update(token, 'utf8').digest('hex'),
    nome,
    ativo: true,
    criadoEm: new Date().toISOString(),
    ultimoAcesso: null,
    acessos: 0,
  });
  const linha = '='.repeat(78);
  console.log('\n' + linha + '\nURL DO FEED CRIADA — copie agora, ela nao aparece de novo\n' + linha);
  console.log('  destino : ' + nome);
  console.log('  id      : ' + id);
  console.log('\n  XML (cole esta no Canal Pro):\n  ' + BASE + '/vrsync/' + token + '.xml');
  console.log('\n  Relatorio (pra voce, abre no navegador):\n  ' + BASE + '/relatorio/' + token);
  console.log(linha);
  console.log('\nQuem tiver essa URL baixa todos os anuncios. Se vazar: revogar ' + id + ' e criar outra.\n');
}

async function listar() {
  const snap = await colTokens().get();
  if (snap.empty) { console.log('\nNenhuma URL criada.\n'); return; }
  console.log('');
  snap.forEach((d) => {
    const t = d.data();
    console.log(d.id);
    console.log('  destino      : ' + (t.nome || '-') + (t.ativo === true ? '' : '   [REVOGADA]'));
    console.log('  criada em    : ' + (t.criadoEm || '-'));
    console.log('  ultima leitura: ' + (t.ultimoAcesso || 'nunca') + (t.ultimoUserAgent ? '  por "' + t.ultimoUserAgent + '"' : ''));
    console.log('  leituras     : ' + (t.acessos || 0) + (t.ultimoTotalAnuncios != null ? '   (' + t.ultimoTotalAnuncios + ' anuncios na ultima)' : ''));
  });
  console.log('');
}

async function revogar(o) {
  const id = o._[0];
  if (!id) { console.error('Uso: node feedPortaisAdmin.js revogar <id>'); process.exit(1); }
  const ref = colTokens().doc(id);
  if (!(await ref.get()).exists) { console.error('Nao existe: ' + id); process.exit(1); }
  await ref.set({ ativo: false, revogadoEm: new Date().toISOString() }, { merge: true });
  console.log('Revogada: ' + id + ' (leva ate 5 min pra valer em todas as instancias).');
}

// ---------------------------------------------------------------------------

(async () => {
  const [cmd, ...resto] = process.argv.slice(2);
  const o = opcoes(resto);
  const comandos = {
    diagnostico, configurar, config: mostrarConfig, cep: definirCep,
    marcar: (x) => marcar(x, true), desmarcar: (x) => marcar(x, false), marcados,
    'criar-url': criarUrl, listar, revogar,
  };
  if (!comandos[cmd]) {
    console.log('\nComandos: diagnostico | configurar | config | cep | marcar | desmarcar | marcados | criar-url | listar | revogar');
    console.log('Detalhes no topo de feedPortaisAdmin.js.\n');
    process.exit(cmd ? 1 : 0);
  }
  iniciar();
  try {
    await comandos[cmd](o);
    process.exit(0);
  } catch (err) {
    console.error('ERRO: ' + err.message);
    process.exit(1);
  }
})();
