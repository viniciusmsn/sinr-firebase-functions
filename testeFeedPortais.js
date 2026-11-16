/**
 * Testes do feed de portais (VRSync).   node testeFeedPortais.js
 *
 * Sem firebase, sem credencial, sem rede — exercita feedPortaisCore.js, que e o
 * codigo que a function e o feedPortaisAdmin.js executam.
 */

const core = require('./feedPortaisCore');

let passou = 0;
let falhou = 0;
function ok(cond, nome, detalhe) {
  if (cond) { passou++; console.log('  ok   ' + nome); }
  else { falhou++; console.log('  FALHA ' + nome + (detalhe ? '  -> ' + detalhe : '')); }
}
function igual(a, b, nome) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  ok(x === y, nome, 'esperado ' + y + ', veio ' + x);
}

const SEGREDOS = {
  ownerName: 'Maria Aparecida Souza',
  ownerPhone: '+5512999998888',
  ownerEmailContact: 'maria.proprietaria@gmail.com',
  ownerNotes: 'aceita 780k a vista',
  ownerEmail: 'corretor.captador@seuimovelnarepresa.com.br',
  cpf: '123.456.789-00',
  rg: '12.345.678-9',
  driveFolder: '1AbCdEfGhIjKlMnOpQrStUvWxYz',
  endereco: 'Rua das Palmeiras, 245, Quadra F',
  latExata: -23.2093947,
  lngExata: -49.0541883,
  comissao: '6% rateio 50/50',
};

const fotos = (n, extra) => Array.from({ length: n }, (_, i) => Object.assign({ id: 'm' + i, type: 'image/jpeg', name: 'f' + i + '.jpg', driveFileId: 'drv' + i }, extra));

const CASA = {
  publishToSite: true,
  codigo: 'I08NI',
  slug: 'casa-a-venda-riviera-i08ni',
  titulo: 'Casa com vista para a represa no Riviera',
  descricao: 'Casa em condomínio fechado, com vista para a represa Jurumirim.\nÁrea gourmet & piscina aquecida.',
  categoria: 'casa',
  finalidade: 'venda',
  precoVenda: '850.000,00',
  cidade: 'Paranapanema',
  bairro: 'Enseada Azul',
  lat: SEGREDOS.latExata, lng: SEGREDOS.lngExata,
  quartos: '3', suites: 1, banheiros: 2, vagas: 2,
  areaTerreno: 1000, areaConstr: '180,5',
  recursos: ['piscina', 'vista_represa', 'condominio', 'pier', 'portaria_24h'],
  media: fotos(6).concat([{ id: 'v', type: 'video/mp4', name: 'tour.mp4', driveFileId: 'vid123' }]),
  videoLinks: ['https://www.youtube.com/watch?v=abcdEFGH123'],
  updatedAt: new Date('2026-11-01T12:00:00Z'),
  // nada daqui pra baixo pode sair
  endereco: SEGREDOS.endereco,
  ownerName: SEGREDOS.ownerName, ownerPhone: SEGREDOS.ownerPhone,
  ownerEmailContact: SEGREDOS.ownerEmailContact, ownerNotes: SEGREDOS.ownerNotes,
  ownerEmail: SEGREDOS.ownerEmail,
  submitterInfo: { nome: SEGREDOS.ownerName, cpf: SEGREDOS.cpf, rg: SEGREDOS.rg },
  authorizationAccepted: { textSnapshot: 'Autorizo...', userAgent: 'Mozilla' },
  commissionPayment: SEGREDOS.comissao,
  driveFolderId: SEGREDOS.driveFolder,
  wpUrl: 'https://antigo.example/imovel', sourceUrl: 'https://antigo.example/x',
};
const TERRENO = {
  publishToSite: true, codigo: 'T01', titulo: 'Terreno plano no Riviera', categoria: 'terreno', finalidade: 'venda',
  descricao: 'Terreno plano de 1.000 m², pronto para construir, em condomínio com portaria.',
  precoVenda: 120000, cidade: 'Paranapanema', bairro: 'Enseada Azul', areaTerreno: 1000, media: fotos(5),
  updatedAt: new Date('2026-10-01T12:00:00Z'),
};
const CFG = { contato: { nome: 'Seu Imóvel na Represa', email: 'contato@exemplo.com.br', telefone: '(14) 99999-0000', site: 'https://seuimovelnarepresa.com.br' } };
const com = (base, extra) => Object.assign({}, base, extra);
const AGORA = new Date('2026-11-16T10:00:00Z');

// ---------------------------------------------------------------------------

console.log('\n== 1. Nada do proprietario nem endereco exato no XML ==');
{
  const { xml } = core.gerarFeed([CASA], CFG, AGORA);
  Object.keys(SEGREDOS).forEach((k) => ok(xml.indexOf(String(SEGREDOS[k])) === -1, 'nao vaza ' + k));
  ok(xml.indexOf('<Address>') === -1 && xml.indexOf('<StreetNumber>') === -1, 'sem Address nem StreetNumber');
  ok(xml.indexOf('displayAddress="Neighborhood"') !== -1, 'displayAddress = Neighborhood');
  ok(xml.indexOf('<Latitude>-23.209</Latitude>') !== -1, 'latitude arredondada a 3 casas');
  ok(xml.indexOf('<Longitude>-49.054</Longitude>') !== -1, 'longitude arredondada a 3 casas');
  ok(xml.indexOf('antigo.example') === -1, 'wpUrl/sourceUrl nao saem');
  ok(xml.indexOf('vid123') === -1, 'video do Drive nao vira foto');
}

console.log('\n== 2. Estrutura VRSync ==');
{
  const { xml } = core.gerarFeed([CASA], CFG, AGORA);
  ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<ListingDataFeed xmlns="http://www.vivareal.com/schemas/1.0/VRSync"'), 'cabecalho e namespace');
  ok(xml.indexOf('xsi:schemaLocation="http://www.vivareal.com/schemas/1.0/VRSync http://xml.vivareal.com/vrsync.xsd"') !== -1, 'schemaLocation');
  ok(xml.indexOf('<PublishDate>2026-11-16T10:00:00</PublishDate>') !== -1, 'PublishDate sem milissegundos');
  ok(xml.indexOf('<ListingID>I08NI</ListingID>') !== -1, 'ListingID = codigo');
  ok(xml.indexOf('<TransactionType>For Sale</TransactionType>') !== -1, 'venda -> For Sale');
  ok(xml.indexOf('<PublicationType>STANDARD</PublicationType>') !== -1, 'PublicationType padrao');
  ok(xml.indexOf('<DetailViewUrl>https://seuimovelnarepresa.com.br/imoveis/casa-a-venda-riviera-i08ni/</DetailViewUrl>') !== -1, 'DetailViewUrl pelo slug, com a barra final (sem ela o site redireciona)');
  ok(core.gerarFeed([com(CASA, { slug: '../x?y=1' })], CFG, AGORA).xml.indexOf('<DetailViewUrl>') === -1, 'slug estranho: anuncio sai sem link, nao com link quebrado');
  ok(xml.indexOf('<ListPrice currency="BRL">850000</ListPrice>') !== -1, 'preco inteiro, sem pontuacao');
  ok(xml.indexOf('<LivingArea unit="square metres">181</LivingArea>') !== -1, 'area util inteira (180,5 -> 181)');
  ok(xml.indexOf('<LotArea unit="square metres">1000</LotArea>') !== -1, 'area total');
  ok(xml.indexOf('<Bedrooms>3</Bedrooms>') !== -1 && xml.indexOf('<Bathrooms>2</Bathrooms>') !== -1, 'quartos e banheiros');
  ok(xml.indexOf('<Garage type="Parking Space">2</Garage>') !== -1, 'vagas');
  ok(xml.indexOf('<PropertyType>Residential / Condo</PropertyType>') !== -1, 'casa com recurso condominio -> Casa de Condominio');
  ok(xml.indexOf('<PostalCode>18727-600</PostalCode>') !== -1, 'CEP do bairro (tabela padrao)');
  ok(xml.indexOf('<State abbreviation="SP">') !== -1 && xml.indexOf('<Country abbreviation="BR">Brasil</Country>') !== -1, 'pais e estado');
  ok(xml.indexOf('<Email>contato@exemplo.com.br</Email>') !== -1, 'contato no anuncio');
  const ordem = ['<ListingID>', '<Title>', '<TransactionType>', '<PublicationType>', '<DetailViewUrl>', '<Media>', '<Details>', '<Location', '<ContactInfo>'].map((t) => xml.indexOf(t));
  ok(ordem.every((p, i) => p > -1 && (i === 0 || p > ordem[i - 1])), 'ordem dos elementos igual a dos exemplos oficiais');
}

console.log('\n== 3. Fotos ==');
{
  const { xml } = core.gerarFeed([CASA], CFG, AGORA);
  igual((xml.match(/<Item medium="image"/g) || []).length, 6, '6 fotos');
  igual((xml.match(/primary="true"/g) || []).length, 1, 'so uma foto de capa');
  ok(xml.indexOf('<Item medium="image" caption="img1" primary="true">https://lh3.googleusercontent.com/d/drv0=w1600-rj</Item>') !== -1, 'capa e a primeira, em JPG pelo CDN');
  ok(xml.indexOf('<Item medium="video">https://www.youtube.com/watch?v=abcdEFGH123</Item>') !== -1, 'video do YouTube');
  igual(core.urlFoto({ type: 'image/png', downloadUrl: 'https://x/a.png' }), null, 'PNG do Storage e descartado (portal so importa JPG)');
  ok(/=w1600-rj$/.test(core.urlFoto({ type: 'image/png', driveFileId: 'abc' })), 'PNG do Drive sai convertido em JPG');
  igual(core.urlFoto({ type: 'image/jpeg', downloadUrl: 'https://x/a.jpg?alt=media&token=1' }), 'https://x/a.jpg?alt=media&token=1', 'JPG do Storage passa');
  const st = core.gerarFeed([com(CASA, { media: fotos(5, { driveFileId: undefined, downloadUrl: 'https://fs/o/a.jpg?alt=media&token=t' }).map((m, i) => com(m, { downloadUrl: m.downloadUrl + i })) })], CFG, AGORA).xml;
  ok(st.indexOf('?alt=media&amp;token=t0</Item>') !== -1, '& da URL do Storage escapado');
  igual(core.urlYoutube(['https://vimeo.com/1', 'https://youtu.be/abcdEFGH123']), 'https://youtu.be/abcdEFGH123', 'ignora video que nao e YouTube');
  igual(core.urlYoutube(['javascript:alert(1)']), null, 'link estranho nao vira video');
  const muitas = core.montarAnuncio(com(CASA, { media: fotos(80) }), CFG);
  igual(muitas.anuncio.fotos.length, core.FOTOS_MAX, 'teto de fotos');
  const rep = core.montarAnuncio(com(CASA, { media: fotos(4).concat(fotos(4)) }), CFG);
  ok(!rep.ok && /tem 4/.test(rep.motivos.join()), 'foto repetida nao conta duas vezes para o minimo (8 itens, 4 unicas)');
}

console.log('\n== 4. Regras do portal que derrubam o anuncio ==');
{
  const motivos = (extra, base) => { const r = core.montarAnuncio(com(base || CASA, extra), CFG); return r.ok ? [] : r.motivos; };
  ok(motivos({ media: fotos(4) }).some((m) => /menos de 5 fotos \(tem 4\)/.test(m)), 'menos de 5 fotos');
  ok(motivos({ descricao: '' }).includes('sem descricao'), 'sem descricao');
  ok(motivos({ descricao: 'Curta demais.' }).some((m) => /descricao com menos de 50/.test(m)), 'descricao curta');
  ok(motivos({ titulo: 'Casa' }).some((m) => /titulo com menos de 10/.test(m)), 'titulo curto');
  ok(motivos({ quartos: null }).some((m) => /^sem quartos/.test(m)), 'casa sem quartos');
  ok(motivos({ banheiros: '' }).some((m) => /^sem banheiros/.test(m)), 'casa sem banheiros');
  ok(motivos({ areaConstr: null }).some((m) => /^sem area construida/.test(m)), 'casa sem area construida');
  ok(motivos({ areaTerreno: null }, TERRENO).some((m) => /^sem area do terreno/.test(m)), 'terreno sem area');
  ok(motivos({ precoVenda: null }).includes('venda sem preco'), 'venda sem preco');
  ok(motivos({ precoVenda: 0 }).includes('venda sem preco'), 'preco zero nao vale');
  ok(motivos({ bairro: 'Bairro Que Nao Existe' }).some((m) => /^sem CEP para Bairro Que Nao Existe \/ Paranapanema/.test(m)), 'bairro sem CEP');
  ok(motivos({ codigo: '' }).includes('sem codigo'), 'sem codigo');
  ok(motivos({ categoria: 'galpao' }).some((m) => /categoria sem tipo/.test(m)), 'categoria desconhecida');
  igual(motivos({}), [], 'a casa completa passa');
  igual(motivos({}, TERRENO), [], 'terreno nao exige quartos, banheiros nem area construida');
  igual(motivos({ media: fotos(4), descricao: '', quartos: null }).length, 3, 'todos os motivos sao listados, nao so o primeiro');
}

console.log('\n== 5. Quem nem e candidato ==');
{
  igual(core.elegivel(CASA, {}), null, 'publicado e disponivel entra');
  ok(core.elegivel(com(CASA, { publishToSite: false }), {}), 'rascunho fica fora');
  ok(core.elegivel(com(CASA, { submissionStatus: 'pending_review' }), {}), 'submissao pendente fica fora');
  ok(core.elegivel(com(CASA, { dealStatus: 'vendido' }), {}), 'vendido fica fora');
  ok(core.elegivel(com(CASA, { dealStatus: 'locado' }), {}), 'locado fica fora');
  igual(core.elegivel(com(CASA, { dealStatus: 'em_negociacao' }), {}), null, 'em negociacao continua anunciado');
  ok(core.elegivel(com(CASA, { publishToPortais: false }), {}), 'publishToPortais=false tira do feed');
  ok(core.elegivel(CASA, { modo: 'marcados' }), 'modo marcados: sem marca fica fora');
  igual(core.elegivel(com(CASA, { publishToPortais: true }), { modo: 'marcados' }), null, 'modo marcados: marcado entra');
}

console.log('\n== 6. Tipos, finalidade e recursos ==');
{
  const tipo = (extra) => core.tipoImovel(com(CASA, extra)).propertyType;
  igual(tipo({ recursos: [] }), 'Residential / Home', 'casa fora de condominio');
  igual(tipo({ categoria: 'terreno' }), 'Residential / Land Lot', 'terreno');
  igual(tipo({ categoria: 'chacara' }), 'Residential / Agricultural', 'chacara');
  igual(tipo({ categoria: 'obra' }), 'Residential / Condo', 'obra em condominio');
  igual(tipo({ categoria: 'apartamento' }), 'Residential / Apartment', 'apartamento');
  igual(core.tipoImovel({ categoria: 'comercial' }).usageType, 'Commercial', 'comercial');
  const a = core.montarAnuncio(CASA, CFG).anuncio;
  igual(a.features, ['Pool', 'Lake View', 'Concierge 24h'], 'recursos mapeados; pier e condominio sem equivalente ficam fora');
  const ambos = core.montarAnuncio(com(CASA, { finalidade: 'ambos', precoLocacao: 4500 }), CFG).anuncio;
  igual([ambos.transacao, ambos.precoVenda, ambos.precoLocacao], ['Sale/Rent', 850000, 4500], 'ambos com os dois precos');
  const soVenda = core.montarAnuncio(com(CASA, { finalidade: 'ambos' }), CFG);
  igual([soVenda.anuncio.transacao, soVenda.anuncio.precoLocacao], ['For Sale', null], '"ambos" sem locacao vira so venda');
  const loc = core.gerarFeed([com(CASA, { finalidade: 'locacao', precoLocacao: 4500 })], CFG, AGORA).xml;
  ok(loc.indexOf('<RentalPrice currency="BRL" period="Monthly">4500</RentalPrice>') !== -1 && loc.indexOf('<ListPrice') === -1, 'locacao: RentalPrice mensal, sem ListPrice');
  igual(core.montarAnuncio(com(CASA, { portaisDestaque: 'PREMIUM' }), CFG).anuncio.publicationType, 'PREMIUM', 'destaque por imovel');
  igual(core.montarAnuncio(com(CASA, { portaisDestaque: 'INVENTADO' }), CFG).anuncio.publicationType, 'STANDARD', 'destaque invalido cai no padrao');
}

console.log('\n== 7. CEP ==');
{
  igual(core.resolveCep({ cidade: 'Paranapanema', bairro: 'Enseada Azul' }, {}), '18727-600', 'tabela padrao');
  igual(core.resolveCep({ cidade: 'PARANAPANEMA', bairro: '  enseada   azul ' }, {}), '18727-600', 'chave ignora caixa e espacos');
  igual(core.resolveCep({ cidade: 'Avaré', bairro: 'Ponta dos Cambarás' }, {}), '18709-600', 'chave ignora acento');
  igual(core.resolveCep({ cidade: 'Paranapanema', bairro: 'Riviera de Santa Cristina XIII' }, {}), null, 'bairro fora da tabela: sem CEP');
  const cfg = { cepPorBairro: { 'paranapanema|riviera de santa cristina xiii': '18727200', 'paranapanema|enseada azul': '18727-999' } };
  igual(core.resolveCep({ cidade: 'Paranapanema', bairro: 'Riviera de Santa Cristina XIII' }, cfg), '18727-200', 'config acrescenta bairro (e formata)');
  igual(core.resolveCep({ cidade: 'Paranapanema', bairro: 'Enseada Azul' }, cfg), '18727-999', 'config vence a tabela padrao');
  igual(core.resolveCep({ cidade: 'Paranapanema', bairro: 'Enseada Azul', cep: '18727-123' }, cfg), '18727-123', 'cep do proprio imovel vence tudo');
  igual(core.normalizaCep('1872-600'), null, 'CEP com 7 digitos e invalido');
  ok(Object.values(core.CEP_PADRAO).every((c) => /^\d{5}-\d{3}$/.test(c)), 'tabela padrao bem formada');
  ok(Object.keys(core.CEP_PADRAO).every((k) => k === core.chaveLugar(k.split('|')[0], k.split('|')[1])), 'chaves da tabela ja normalizadas');
}

console.log('\n== 8. Texto e XML ==');
{
  igual(core.esc('A & B <c> "d" \'e\''), 'A &amp; B &lt;c&gt; &quot;d&quot; &apos;e&apos;', 'escape');
  igual(core.cdata('a]]>b'), '<![CDATA[a]]]]><![CDATA[>b]]>', 'CDATA com ]]> dentro');
  igual(core.limpaTexto('<p>Casa <b>linda</b></p><script>x()</script>', false), 'Casa linda x()', 'tags removidas');
  igual(core.limpaTexto('terreno < 500 m2 e > 300', false), 'terreno < 500 m2 e > 300', 'sinal de menor/maior no texto sobrevive');
  igual(core.limpaTexto('a\u0000b\u0008c\u001Fd', false), 'abcd', 'caractere de controle invalido em XML some');
  igual(core.limpaTexto('linha 1\r\n\r\n\r\n\r\nlinha 2', true), 'linha 1\n\nlinha 2', 'quebras colapsadas');
  const longo = core.montarAnuncio(com(CASA, { titulo: 'Casa '.repeat(40) }), CFG);
  ok(longo.ok && longo.anuncio.titulo.length <= 100 && !/\s$/.test(longo.anuncio.titulo), 'titulo longo cortado em palavra inteira');
  ok(longo.avisos.some((a) => /titulo cortado/.test(a)), 'corte de titulo vira aviso');
  const desc = core.montarAnuncio(com(CASA, { descricao: 'palavra '.repeat(600) }), CFG);
  ok(desc.ok && desc.anuncio.descricao.length <= 3000, 'descricao longa cortada em 3000');
  const { xml } = core.gerarFeed([com(CASA, { titulo: 'Casa & Chácara <top> ]]> "linda"' })], CFG, AGORA);
  ok(xml.indexOf('<Title><![CDATA[Casa & Chácara ]]]]><![CDATA[> "linda"]]></Title>') !== -1, 'titulo com & e ]]> continua XML valido');
  ok(xml.indexOf('Jurumirim.<br>Área gourmet & piscina aquecida.]]></Description>') !== -1, 'quebra de linha vira <br> na descricao');
  // bem-formado: toda tag aberta fecha, na ordem
  const semCdata = xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  const pilha = []; let bemFormado = true; let m; const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>/g;
  while ((m = re.exec(semCdata)) !== null) { if (m[3]) continue; if (m[1]) { if (pilha.pop() !== m[2]) bemFormado = false; } else pilha.push(m[2]); }
  ok(bemFormado && pilha.length === 0, 'XML bem-formado (tags pareadas)');
  ok(!/&(?!amp;|lt;|gt;|quot;|apos;)/.test(semCdata), 'nenhum & solto fora de CDATA');
}

console.log('\n== 9. Feed inteiro: relatorio, duplicado, limite, contato ==');
{
  const docs = [
    CASA, TERRENO,
    com(CASA, { codigo: 'DUP', updatedAt: new Date('2026-09-01') }), com(TERRENO, { codigo: 'DUP' }),
    com(CASA, { codigo: 'V1', dealStatus: 'vendido' }),
    com(CASA, { codigo: 'F1', media: fotos(2) }),
    com(CASA, { codigo: 'B1', bairro: 'Riviera de Santa Cristina XIII' }),
    com(CASA, { codigo: 'B2', bairro: 'Riviera de Santa Cristina XIII' }),
  ];
  const { xml, relatorio: r } = core.gerarFeed(docs, CFG, AGORA);
  igual(r.candidatos, 7, 'vendido nem e candidato');
  igual(r.foraDoEscopo, { 'vendido ou locado': 1 }, 'vendido contado a parte');
  igual(r.incluidos, 3, 'entram 3');
  igual(r.codigosIncluidos, ['I08NI', 'T01', 'DUP'], 'mais recente primeiro');
  igual((xml.match(/<Listing>/g) || []).length, 3, '3 <Listing> no XML');
  igual((xml.match(/<ListingID>DUP<\/ListingID>/g) || []).length, 1, 'codigo duplicado sai uma vez so');
  ok(r.excluidos.some((e) => e.codigo === 'DUP' && /duplicado/.test(e.motivos[0])), 'o duplicado aparece no relatorio');
  igual(r.semCepPorBairro, { 'Riviera de Santa Cristina XIII / Paranapanema': 2 }, 'bairros sem CEP agrupados');
  igual(r.porMotivo['poucas fotos'], 1, 'motivos agrupados sem o numero');
  const frouxo = core.gerarFeed(docs, com(CFG, { fotosMinimas: 2 }), AGORA).relatorio;
  ok(frouxo.codigosIncluidos.includes('F1'), 'fotosMinimas na config afrouxa o minimo (2 fotos passam)');
  ok(!core.montarAnuncio(com(CASA, { media: [] }), com(CFG, { fotosMinimas: 0 })).ok, 'mas nunca abaixo de 1 foto');
  ok(JSON.stringify(r).indexOf(SEGREDOS.ownerName) === -1 && JSON.stringify(r).indexOf(SEGREDOS.endereco) === -1, 'relatorio nao carrega dado do proprietario');

  const lim = core.gerarFeed(docs, com(CFG, { limite: 2 }), AGORA).relatorio;
  igual([lim.incluidos, lim.cortadosPeloLimite], [2, ['DUP']], 'limite corta os menos recentes');

  const semContato = core.gerarFeed(docs, {}, AGORA);
  ok(semContato.xml === null && /contato nao configurado/.test(semContato.relatorio.erro), 'sem contato nao gera XML');
  igual(semContato.relatorio.incluidos, 3, 'mas o relatorio ainda diz quem entraria');
  igual(core.contatoValido({ contato: { nome: 'X', email: 'sem-arroba' } }), null, 'e-mail invalido nao vale');

  const vazio = core.gerarFeed([], CFG, AGORA);
  ok(vazio.xml.indexOf('<Listings>\n  </Listings>') !== -1, 'feed vazio continua valido');
}

console.log('\n== 10. select() cobre tudo que o codigo le ==');
{
  const fonte = require('fs').readFileSync(require('path').join(__dirname, 'feedPortaisCore.js'), 'utf8');
  const lidos = new Set([...fonte.matchAll(/\bd\.([a-zA-Z]+)\b/g)].map((m) => m[1]));
  const faltando = [...lidos].filter((c) => !core.CAMPOS_LIDOS.includes(c));
  igual(faltando, [], 'todo d.campo lido esta em CAMPOS_LIDOS (senao chega vazio, sem erro)');
  const proibidos = ['endereco', 'ownerName', 'ownerPhone', 'ownerEmail', 'ownerEmailContact', 'ownerNotes', 'submitterInfo', 'authorizationAccepted', 'commissionPayment', 'driveFolderId'];
  igual(core.CAMPOS_LIDOS.filter((c) => proibidos.includes(c)), [], 'nenhum campo sensivel no select()');
}

console.log('\n' + (falhou === 0 ? 'TODOS OS ' + passou + ' TESTES PASSARAM' : falhou + ' FALHA(S) de ' + (passou + falhou)));
process.exit(falhou === 0 ? 0 : 1);
