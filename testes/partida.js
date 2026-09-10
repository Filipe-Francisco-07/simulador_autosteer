// A rotina de partida: o que acontece se alguem pular o "zerar as rodas".
//
// Sem WAS o angulo e relativo ao boot — o acumulador comeca em zero onde quer
// que as rodas estejam. O AOG, por sua vez, GUARDA o wasOffset entre sessoes e
// o reenvia na partida, apontando para uma origem que nao existe mais. Em
// 30/08 o offset salvo era 283 e o angulo nascia a dezenas de graus do real,
// em silencio.
//
// O firmware absorve esse offset, mas o MECANISMO mudou em 07/09. Antes era uma
// ancora (commit eb58f4f): o primeiro PGN 252 depois do boot virava o "centro".
// Essa funcao (`ancorarOffset`) ficou no logica_direcao.h mas nao e mais chamada
// por ninguem — codigo morto, junto com `engateDecidir` e `bloqueioExpirou`.
//
// Quem faz o trabalho agora e `confirmarCentro()`, que grava
// `centro = acumulado + offset` no zero de partida. A conta se cancela igual:
//   angulo = (acumulado - centro + offset)/cpd = 0
// Ou seja o resultado esperado deste teste nao mudou; a razao dele mudou.
// Este teste confere se o offset herdado continua sendo absorvido.
//
//   node testes/partida.js <simulado|bancada>
const { Piloto } = require('./piloto.js');

(async () => {
  const modo = process.argv[2] || 'simulado';
  const p = new Piloto();
  await p.pronto;
  const naPlaca = modo === 'bancada';
  await p.zerar();
  if (naPlaca) {
    const ok = await p.usarPlaca();
    console.log(ok ? 'BANCADA — ESP32 traduzindo\n' : 'placa nao respondeu como bancada\n');
  } else { await p.usarSimulado(); console.log('SIMULADO\n'); }

  // Parte de um estado verificado. Sem isto, uma roda deixada no batente pelo
  // roteiro anterior faz o modulo centrar torto e o teste mede outra coisa.
  for (let i = 0; i < 4; i++) {
    await p.zerar();
    await p.espera(1200);
    if (Math.abs(p.amostra().estimado) < 0.5) break;
  }
  const inicio = p.amostra();
  console.log(`  0. arranque limpo: estimado ${inicio.estimado.toFixed(2)}° · roda ${inicio.roda.toFixed(2)}°
`);

  // 1. offset herdado de outra sessao, como o AOG manda na partida
  const OFFSET_HERDADO = 283;    // o valor real do dump de 30/08
  p.envia('ajustes', { ganhoP: 20, contagensPorGrau: 19, pwmMinimo: 25,
                        pwmAlto: 180, offsetDirecao: OFFSET_HERDADO });
  await p.espera(1500);
  const aoLigar = p.amostra();
  console.log(`  1. offset ${OFFSET_HERDADO} herdado chega DEPOIS da centragem`);
  console.log(`     angulo ao ligar: ${aoLigar.estimado.toFixed(2)}° (roda em ${aoLigar.roda.toFixed(2)}°)`);
  const ancorou = Math.abs(aoLigar.estimado - aoLigar.roda) < 1;
  console.log(`     ${ancorou ? 'o offset foi absorvido: o angulo acompanha a roda'
    : 'FALHA: o angulo descolou ' + (aoLigar.estimado - aoLigar.roda).toFixed(2) + '° da roda, em silencio'}`);

  // 2. gira o volante e volta: o angulo deve acompanhar
  p.envia('dirOn', true); await p.espera(2200); p.envia('dirOn', false);
  await p.espera(800);
  const girado = p.amostra();
  console.log(`\n  2. depois de girar: estimado ${girado.estimado.toFixed(2)}° · roda ${girado.roda.toFixed(2)}°`);
  const diferenca = Math.abs(girado.estimado - girado.roda);
  console.log(`     diferenca ${diferenca.toFixed(2)}° ${diferenca < 1 ? '(acompanha)' : '(DESCOLOU)'}`);

  // 3. o botao zerar, com as rodas tortas
  p.envia('wasZero');
  await p.espera(1200);
  const zerado = p.amostra();
  console.log(`\n  3. apertou "zerar rodas" com a roda em ${girado.roda.toFixed(1)}°`);
  console.log(`     angulo agora: ${zerado.estimado.toFixed(2)}° ${Math.abs(zerado.estimado) < 1 ? '(zerou)' : '(NAO ZEROU)'}`);
  console.log(`     >> e por isso que a rotina manda zerar com as RODAS RETAS:`);
  console.log(`        zerar torto ensina ao modulo que torto e o zero`);

  // Nao ha passo 4 medindo "o offset chegando ANTES da centragem".
  //
  // Tentei duas construcoes e as duas sao corrida, nao teste: segurar com o
  // trator andando falha porque o modulo centra na fresta entre o reinicio e a
  // arrancada, e cortar o heartbeat falha porque o proprio 'reset' religa o
  // motor de proposito (para um roteiro nao contaminar o seguinte). Preferi nao
  // versionar demonstracao que passa por sorte.
  //
  // O passo 3 ja mostra o mecanismo, e ele e o ponto: o offsetDirecao SERVE
  // para deslocar o zero — e assim que o botao "zerar rodas" funciona. O
  // problema nao e o offset agir; e um offset GUARDADO de outra sessao agir de
  // novo. Ele valia no referencial daquele boot, e o encoder nasce zerado a
  // cada energizada, entao no boot seguinte ele desloca o zero em
  // offset/CPD graus sem nada na tela.
  console.log(`
  >> POR QUE ISSO IMPORTA`);
  console.log(`     O "zerar rodas" grava o ajuste no perfil do AgOpenGPS, entao`);
  console.log(`     em uso normal o offset NAO e zero. Na proxima partida o AgIO`);
  console.log(`     reenvia esse valor e, se ele chegar depois da centragem, o`);
  console.log(`     zero do modulo desloca ${OFFSET_HERDADO}/19 = 14,89 graus, calado.`);
  console.log(`     Foi o que se viu no campo em 30/08.`);

  p.fechar();
  // Falha de verdade quando o offset nao e absorvido: isto e o defeito que
  // perdeu o teste de campo de 30/08, e um teste que so imprime aviso e sai
  // com codigo 0 nao impede que ele volte.
  process.exit(ancorou ? 0 : 1);
})();
