/**
 * Testes da logica publica da API de imoveis.
 *
 *   node testeApiImoveis.js
 *
 * Nao precisa de firebase, credencial nem rede — so exercita apiImoveisCore.js.
 * O teste mais importante e o "vazamento de PII": monta um doc com TODOS os
 * campos proibidos preenchidos e afirma que nenhum valor sensivel aparece no
 * JSON da resposta. Rode isso sempre que mexer na whitelist.
 */

const core = require('./apiImoveisCore');

let passou = 0;
let falhou = 0;

function ok(cond, nome, detalhe) {
  if (cond) { passou++; console.log('  ok   ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}

function igual(a, b, nome) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  ok(x === y, nome, 'esperado ' + y + ', veio ' + x);
}

// ---------------------------------------------------------------------------
// Doc de exemplo com TODO campo sensivel preenchido
// ---------------------------------------------------------------------------

const SEGREDOS = {
  ownerName: 'Maria Aparecida Souza',
  ownerPhone: '+5512999998888',
  ownerEmailContact: 'maria.proprietaria@gmail.com',
  ownerNotes: 'aceita 780k a vista, precisa vender rapido',
  ownerEmail: 'corretor.captador@seuimovelnarepresa.com.br',
  cpfSubmitter: '123.456.789-00',
  rgSubmitter: '12.345.678-9',
  driveFolder: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
  driveFile: '14Ee3X0lL8e8VmdrYZx0Wp2DhAKmdcK8u',
  enderecoExato: 'Rua das Palmeiras, 245, Quadra F',
  latExata: -22.7183947,
  lngExata: -46.5521883,
  wpUrl: 'https://seuimovelnarepresa.com.br/imovel/casa-antiga',
  comissao: '6% rateio 50/50 com o Joao',
};

const DOC_COMPLETO = {
  publishToSite: true,
  submissionStatus: 'approved',
  codigo: 'SIR-1042',
  titulo: 'Casa com vista para a represa',
  descricao: 'Casa em condominio fechado.',
  categoria: 'casa',
  finalidade: 'venda',
  precoVenda: '850.000,00',
  precoLocacao: null,
  cidade: 'Águas de Santa Bárbara',
  bairro: 'Riviera de Santa Cristina XIII',
  endereco: SEGREDOS.enderecoExato,
  lat: SEGREDOS.latExata,
  lng: SEGREDOS.lngExata,
  quartos: '3', suites: 1, banheiros: 2, vagas: '2',
  areaTerreno: 1000, areaConstr: '180',
  recursos: ['piscina', 'vista_represa'],
  aptoFinanciamento: true,
  dealStatus: 'disponivel',
  media: [
    { id: 'm1', type: 'image/jpeg', name: 'frente.jpg', size: 900, driveFileId: SEGREDOS.driveFile },
    { id: 'm2', type: 'image/jpeg', name: 'fundos.jpg', downloadUrl: 'https://firebasestorage.googleapis.com/v0/b/x/o/y.jpg?alt=media&token=abc' },
    { id: 'm3', type: 'video/mp4', name: 'tour.mp4', driveFileId: 'vid123' },
  ],
  updatedAt: new Date('2026-07-30T12:00:00Z'),
  createdAt: new Date('2026-01-01T00:00:00Z'),

  // Tudo daqui pra baixo NAO pode sair.
  ownerName: SEGREDOS.ownerName,
  ownerPhone: SEGREDOS.ownerPhone,
  ownerEmailContact: SEGREDOS.ownerEmailContact,
  ownerNotes: SEGREDOS.ownerNotes,
  ownerEmail: SEGREDOS.ownerEmail,
  submitterInfo: { nome: SEGREDOS.ownerName, cpf: SEGREDOS.cpfSubmitter, rg: SEGREDOS.rgSubmitter },
  authorizationAccepted: { textSnapshot: 'Autorizo...', userAgent: 'Mozilla/5.0' },
  commissionPayment: SEGREDOS.comissao,
  driveFolderId: SEGREDOS.driveFolder,
  prevContact: true,
  partnerFavoritedBy: ['parceiro@x.com'],
  sourceUrl: SEGREDOS.wpUrl,
  wpPostId: 4321,
  wpUrl: SEGREDOS.wpUrl,
};

// ---------------------------------------------------------------------------

console.log('\n== 1. Vazamento de PII e de campo interno ==');
{
  const pub = core.limpar(core.paraPublico(DOC_COMPLETO));
  const json = JSON.stringify(pub);

  Object.keys(SEGREDOS).forEach((k) => {
    if (k === 'driveFile') return; // testado a parte: pode aparecer dentro da URL da foto
    ok(json.indexOf(String(SEGREDOS[k])) === -1, 'nao vaza ' + k);
  });

  ['ownerName', 'ownerPhone', 'ownerEmailContact', 'ownerNotes', 'ownerEmail',
   'submitterInfo', 'authorizationAccepted', 'commissionPayment', 'driveFolderId',
   'prevContact', 'partnerFavoritedBy', 'sourceUrl', 'wpPostId', 'wpUrl',
   'endereco', 'lat', 'lng', 'media', '_cidadeNorm', '_bairroNorm',
  ].forEach((campo) => {
    ok(!(campo in pub), 'campo ausente na resposta: ' + campo);
  });
}

console.log('\n== 2. Decisao 1: coordenada so aproximada ==');
{
  const pub = core.paraPublico(DOC_COMPLETO);
  igual(pub.localizacaoAproximada.lat, -22.718, 'lat arredondada a 3 casas');
  igual(pub.localizacaoAproximada.lng, -46.552, 'lng arredondada a 3 casas');
  ok(pub.localizacaoAproximada.lat !== SEGREDOS.latExata, 'lat exata nao sai');
  ok(pub.localizacaoAproximada.lng !== SEGREDOS.lngExata, 'lng exata nao sai');
  // 3 casas ~ 110 m: precisa ser impossivel recuperar a casa exata.
  const erroMetros = Math.abs(SEGREDOS.latExata - pub.localizacaoAproximada.lat) * 111320;
  ok(erroMetros > 10, 'deslocamento real de ~' + erroMetros.toFixed(0) + ' m');
}

console.log('\n== 3. Fotos ==');
{
  const pub = core.paraPublico(DOC_COMPLETO);
  igual(pub.fotos.length, 2, 'video fica de fora, so as 2 imagens entram');
  igual(pub.fotos[0].url,
    'https://lh3.googleusercontent.com/d/' + SEGREDOS.driveFile + '=w1600',
    'foto do Drive vira URL lh3 pronta');
  igual(pub.fotos[0].thumb,
    'https://lh3.googleusercontent.com/d/' + SEGREDOS.driveFile + '=w400',
    'thumb do Drive em w400');
  ok(pub.fotos[1].url.indexOf('firebasestorage.googleapis.com') === 0 ||
     pub.fotos[1].url.indexOf('https://firebasestorage') === 0,
     'foto do Storage usa a downloadUrl original');
  const json = JSON.stringify(pub.fotos);
  ok(json.indexOf('driveFileId') === -1, 'a chave driveFileId nunca aparece');
  ok(json.indexOf('vid123') === -1, 'id do video nao vaza');
}

console.log('\n== 4. Filtro de publicacao ==');
{
  ok(core.paraPublico(Object.assign({}, DOC_COMPLETO, { publishToSite: false })) === null,
     'rascunho (publishToSite false) nao sai');
  ok(core.paraPublico(Object.assign({}, DOC_COMPLETO, { publishToSite: undefined })) === null,
     'sem publishToSite nao sai');
  ok(core.paraPublico(Object.assign({}, DOC_COMPLETO, { submissionStatus: 'pending_review' })) === null,
     'submissao pendente nao sai');
  ok(core.paraPublico(Object.assign({}, DOC_COMPLETO, { submissionStatus: 'rejected' })) === null,
     'submissao rejeitada nao sai');
  ok(core.paraPublico(Object.assign({}, DOC_COMPLETO, { submissionStatus: undefined })) !== null,
     'cadastro interno (sem submissionStatus) sai');
  ok(core.paraPublico(DOC_COMPLETO) !== null, 'submissao aprovada sai');
}

console.log('\n== 5. Numeros em pt-BR ==');
{
  igual(core.paraNumero('850.000,00'), 850000, '"850.000,00" -> 850000');
  igual(core.paraNumero('R$ 1.250.000'), 1250000, '"R$ 1.250.000" -> 1250000');
  igual(core.paraNumero('850000'), 850000, '"850000" -> 850000');
  igual(core.paraNumero(850000), 850000, 'number passa direto');
  igual(core.paraNumero(''), null, 'vazio -> null');
  igual(core.paraNumero(null), null, 'null -> null');
  igual(core.paraNumero('1200.50'), 1200.5, 'decimal com ponto preservado');
  igual(core.paraInteiro('3'), 3, '"3" -> 3');
}

console.log('\n== 6. Filtros da listagem ==');
{
  const base = core.paraPublico(DOC_COMPLETO);
  const vendido = Object.assign({}, base, { codigo: 'SIR-2', dealStatus: 'vendido' });
  const barato = Object.assign({}, base, { codigo: 'SIR-3', precoVenda: 200000, quartos: 1 });
  const outroBairro = Object.assign({}, base, {
    codigo: 'SIR-4', bairro: 'Centro', _bairroNorm: core.semAcento('Centro'),
  });
  const itens = [base, vendido, barato, outroBairro];

  igual(core.aplicarFiltros(itens, {}).length, 3, 'vendido fica fora por padrao');
  igual(core.aplicarFiltros(itens, { incluirIndisponiveis: 'true' }).length, 4,
        'incluirIndisponiveis=true traz o vendido');
  igual(core.aplicarFiltros(itens, { precoMin: 500000 }).map((i) => i.codigo),
        ['SIR-1042', 'SIR-4'], 'precoMin corta o barato');
  igual(core.aplicarFiltros(itens, { precoMax: 300000 }).map((i) => i.codigo),
        ['SIR-3'], 'precoMax');
  igual(core.aplicarFiltros(itens, { quartosMin: 3 }).map((i) => i.codigo),
        ['SIR-1042', 'SIR-4'], 'quartosMin');
  // base e barato ficam no Riviera; outroBairro fica no Centro.
  igual(core.aplicarFiltros(itens, { bairro: 'riviera de santa cristina xiii' }).map((i) => i.codigo),
        ['SIR-1042', 'SIR-3'], 'bairro normalizado (sem acento, minusculo)');
  igual(core.aplicarFiltros(itens, { bairro: 'Centro' }).map((i) => i.codigo),
        ['SIR-4'], 'bairro filtra de fato quem nao e do bairro');
  igual(core.aplicarFiltros(itens, { cidade: 'aguas de santa barbara' }).length, 3,
        'cidade casa mesmo escrita sem acento');
  igual(core.aplicarFiltros(itens, { recursos: 'piscina,vista_represa' }).length, 3,
        'recursos exige todos');
  igual(core.aplicarFiltros(itens, { recursos: 'pier' }).length, 0,
        'recurso ausente zera o resultado');
  igual(core.aplicarFiltros(itens, { aptoFinanciamento: 'true' }).length, 3, 'aptoFinanciamento=true');
  igual(core.aplicarFiltros(itens, { aptoFinanciamento: 'false' }).length, 0, 'aptoFinanciamento=false');
  igual(core.aplicarFiltros(itens, { atualizadoDesde: '2026-08-01' }).length, 0,
        'atualizadoDesde no futuro nao traz nada');
  igual(core.aplicarFiltros(itens, { atualizadoDesde: '2026-01-01' }).length, 3,
        'atualizadoDesde no passado traz tudo (sync incremental)');
}

console.log('\n== 7. Finalidade "ambos" e preco de locacao ==');
{
  const ambos = core.paraPublico(Object.assign({}, DOC_COMPLETO, {
    codigo: 'SIR-9', finalidade: 'ambos', precoLocacao: 3500,
  }));
  igual(core.aplicarFiltros([ambos], { finalidade: 'venda' }).length, 1, '"ambos" casa com venda');
  igual(core.aplicarFiltros([ambos], { finalidade: 'locacao' }).length, 1, '"ambos" casa com locacao');
  igual(core.aplicarFiltros([ambos], { finalidade: 'locacao', precoMax: 4000 }).length, 1,
        'na locacao o preco filtrado e o precoLocacao');
  igual(core.aplicarFiltros([ambos], { finalidade: 'locacao', precoMax: 3000 }).length, 0,
        'precoMax de locacao corta corretamente');
}

console.log('\n== 8. Ordenacao ==');
{
  const a = { codigo: 'A', precoVenda: 300000, precoLocacao: null };
  const b = { codigo: 'B', precoVenda: 100000, precoLocacao: null };
  const c = { codigo: 'C', precoVenda: null, precoLocacao: 2000 };
  igual(core.ordenar([a, b, c], 'preco_asc').map((i) => i.codigo), ['C', 'B', 'A'], 'preco_asc');
  igual(core.ordenar([a, b, c], 'preco_desc').map((i) => i.codigo), ['A', 'B', 'C'], 'preco_desc');
  igual(core.ordenar([a, b, c], undefined).map((i) => i.codigo), ['A', 'B', 'C'],
        'sem ordenar mantem a ordem do catalogo');
}

console.log('\n== 9. Doc degenerado nao derruba a API ==');
{
  const minimo = core.paraPublico({ publishToSite: true });
  ok(minimo !== null, 'doc quase vazio ainda gera item');
  igual(minimo.fotos, [], 'sem media -> fotos vazio');
  igual(minimo.localizacaoAproximada.lat, null, 'sem lat -> null');
  igual(minimo.dealStatus, 'disponivel', 'dealStatus assume disponivel');
  igual(minimo.recursos, [], 'sem recursos -> array vazio');
  igual(minimo.atualizadoEm, null, 'sem data -> null');
  igual(core.paraPublico({ publishToSite: true, media: [{ type: 'image/jpeg' }] }).fotos, [],
        'media sem driveFileId nem downloadUrl e descartada');
}

console.log('\n' + (falhou === 0
  ? 'TODOS OS ' + passou + ' TESTES PASSARAM'
  : falhou + ' FALHA(S) de ' + (passou + falhou)));

process.exit(falhou === 0 ? 0 : 1);
