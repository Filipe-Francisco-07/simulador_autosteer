// A rotina de partida: o que acontece se alguem pular o "zerar as rodas".
//
// Sem WAS o angulo e relativo ao boot — o acumulador comeca em zero onde quer
// que as rodas estejam. O AOG, por sua vez, GUARDA o wasOffset entre sessoes e
// o reenvia na partida, apontando para uma origem que nao existe mais. Em
// 30/08 o offset salvo era 283 e o angulo nascia a dezenas de graus do real,
// em silencio.
//
// O firmware ganhou uma ancora (commit eb58f4f): o primeiro PGN 252 depois do
// boot vira o "centro", e os dois se cancelam. Este teste confere se ela pega.
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

  // 1. offset herdado de outra sessao, como o AOG manda na partida
  const OFFSET_HERDADO = 283;    // o valor real do dump de 30/08
  p.envia('ajustes', { ganhoP: 20, contagensPorGrau: 100, pwmMinimo: 25,
                        pwmAlto: 180, offsetDirecao: OFFSET_HERDADO });
  await p.espera(1500);
  const aoLigar = p.amostra();
  console.log(`  1. offset ${OFFSET_HERDADO} herdado chega na partida`);
  console.log(`     angulo ao ligar: ${aoLigar.estimado.toFixed(2)}° (roda em ${aoLigar.roda.toFixed(2)}°)`);
  const ancorou = Math.abs(aoLigar.estimado) < 1;
  console.log(`     ${ancorou ? 'a ancora pegou: o angulo nasceu em zero' : 'ATENCAO: o angulo nasceu fora de zero'}`);

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

  p.fechar();
  process.exit(0);
})();
