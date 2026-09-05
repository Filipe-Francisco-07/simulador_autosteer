// A hipotese do Pedro (analise de 01/09): a trava de seguranca fica presa
// entre sessoes, e o modulo nunca mais engata.
//
// O raciocinio dele, lido no codigo:
//
//     inline bool engateDecidir(bool pedido, bool& trava) {
//         if (!pedido) trava = false;   // so cai na BORDA DE DESCIDA
//         return pedido && !trava;
//     }
//
// Se a trava esta `true` e o AOG manda `engatar:true` DIRETO — sem nunca ter
// mandado `false` naquele boot — nao ha borda de descida, e o piloto fica
// preso desligado ate o ESP32 reiniciar. A analise diz: "nao ha como confirmar
// sem a placa". Temos a placa e a malha fechando, entao da para confirmar.
//
//   node testes/trava-presa.js <bancada|simulado>
const { Piloto } = require('./piloto.js');

(async () => {
  const modo = process.argv[2] || 'bancada';
  const p = new Piloto();
  await p.pronto;
  await p.zerar();
  if (modo === 'bancada') {
    const ok = await p.usarPlaca();
    console.log(ok ? 'BANCADA — ESP32 traduzindo\n' : 'placa nao respondeu como bancada\n');
  } else {
    await p.usarSimulado();
    console.log('SIMULADO\n');
  }

  p.envia('ajustes', { ganhoP: 20, contagensPorGrau: 100, pwmMinimo: 25, pwmAlto: 180 });
  await p.prepararLinha();

  // 1. engata normalmente
  p.engatar();
  await p.espera(3500);
  const engatou = p.amostra().piloto;
  console.log(`  1. engate normal ................. ${engatou ? 'aciona' : 'NAO ACIONOU'}`);
  if (!engatou) { console.log('\n  (nao chegou a engatar; o resto do teste nao vale)'); p.fechar(); process.exit(1); }

  // 2. provoca o override: mao no volante ate a trava armar
  p.envia('maoNoVolante', true);
  await p.espera(2500);
  const largou = !p.amostra().piloto;
  console.log(`  2. mao no volante ................ ${largou ? 'largou (trava armada)' : 'NAO LARGOU'}`);
  p.envia('maoNoVolante', false);
  await p.espera(1500);

  // 3. o AOG CONTINUA pedindo engate, sem nunca soltar.
  //    E aqui que a hipotese diz que ele fica preso.
  const aindaPreso = !p.amostra().piloto;
  console.log(`  3. mao saiu, AOG segue pedindo ... ${aindaPreso ? 'continua solto (trava presa)' : 'voltou a acionar'}`);

  // 4. o operador desliga e liga de novo: a borda de descida deve destravar
  p.envia('piloto');            // desengata -> borda de descida
  await p.espera(1200);
  p.envia('piloto');            // engata de novo
  await p.espera(3000);
  const destravou = p.amostra().piloto;
  console.log(`  4. desliga e liga na tela ........ ${destravou ? 'VOLTOU a acionar' : 'CONTINUA PRESO'}`);

  console.log('\n  leitura:');
  if (aindaPreso && destravou) {
    console.log('  A trava funciona como projetado: segura ate o operador desligar o piloto.');
    console.log('  A hipotese do Pedro se sustenta — um AOG que so manda `engatar:true`');
    console.log('  (sem nunca mandar false) nao consegue destravar, e parece morto.');
  } else if (!aindaPreso) {
    console.log('  A trava NAO ficou presa: o modulo voltou a acionar sozinho depois que');
    console.log('  a mao saiu. Isso CONTRARIA a hipotese.');
  } else {
    console.log('  A trava ficou presa E nao soltou nem com o ciclo desliga/liga.');
    console.log('  Isso e mais grave que a hipotese: nem o operador consegue recuperar.');
  }
  p.parar();
  p.fechar();
  process.exit(0);
})();
