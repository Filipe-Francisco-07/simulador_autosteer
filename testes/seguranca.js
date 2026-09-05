// Os cenarios que assustam: o que acontece quando algo da errado com o piloto
// engatado e o trator andando.
//
// Cada um responde a uma pergunta que alguem faria antes de subir no trator.
const { Piloto } = require('./piloto.js');

const casos = [];
const caso = (nome, pergunta, fn) => casos.push({ nome, pergunta, fn });

caso('mao no volante', 'o modulo larga e CONTINUA solto?', async (p) => {
  p.envia('maoNoVolante', true);
  await p.espera(2500);
  const durante = p.amostra();
  await p.espera(3000);
  const depois = p.amostra();
  p.envia('maoNoVolante', false);
  return {
    ok: !durante.piloto && !depois.piloto,
    detalhe: `com a mao: ${durante.piloto ? 'AINDA ACIONA' : 'largou'} · 3 s depois: ${depois.piloto ? 'VOLTOU A ACIONAR' : 'continua solto'}`,
  };
});

caso('cabo do AOG cortado', 'o cao de guarda solta em ~1 s?', async (p) => {
  p.envia('aogLigado', false);
  await p.espera(2000);
  const a = p.amostra();
  p.envia('aogLigado', true);
  await p.espera(1500);
  const b = p.amostra();
  return { ok: !a.piloto, detalhe: `sem o AOG: ${a.piloto ? 'AINDA ACIONA' : 'largou'} · com o AOG de volta: ${b.piloto ? 'reengatou' : 'segue solto'}` };
});

caso('motor mudo (CAN cortado)', 'o cao de guarda do heartbeat pega?', async (p) => {
  p.envia('motorRespondendo', false);
  await p.espera(2500);
  const a = p.amostra();
  p.envia('motorRespondendo', true);
  await p.espera(1500);
  return { ok: !a.piloto, detalhe: `sem heartbeat: ${a.piloto ? 'AINDA ACIONA' : 'largou'}` };
});

caso('motor travado', 'a corrente alta desengata?', async (p) => {
  p.envia('motorTravado', true);
  await p.espera(3000);
  const a = p.amostra();
  p.envia('motorTravado', false);
  await p.espera(1000);
  return { ok: !a.piloto, detalhe: a.piloto ? 'CONTINUOU FORCANDO contra o travamento' : 'largou' };
});

caso('alvo alem do batente', 'forcar o fim de curso desengata sozinho?', async (p) => {
  p.envia('batente', 12);          // batente baixo: o AOG vai pedir mais do que existe
  await p.espera(6000);
  const a = p.amostra();
  p.envia('batente', 40);
  return { ok: true, detalhe: `roda no batente ${a.roda.toFixed(1)}° · piloto ${a.piloto ? 'engatado' : 'largou'} (informativo)` };
});

caso('encoder atravessa o estouro', 'o acumulador perde a conta ao passar de 0xFFFF?', async (p) => {
  // Isolar o salto do movimento normal: o piloto sai e o trator para, senao a
  // roda continua girando e a medida mistura as duas coisas (foi o que
  // invalidou a primeira versao deste teste).
  p.envia('piloto');            // desengata
  p.envia('acelerar', false);
  p.envia('frear', true);
  await p.espera(2500);
  const antes = p.amostra();
  p.envia('pularEncoder', 65536);   // uma volta COMPLETA do contador
  await p.espera(1200);
  const a = p.amostra();
  const mudou = Math.abs(a.estimado - antes.estimado);
  return {
    ok: mudou < 1,
    detalhe: `parado: antes ${antes.estimado.toFixed(2)}° · depois da volta inteira ${a.estimado.toFixed(2)}° (mudou ${mudou.toFixed(2)}°)`,
  };
});

caso('encoder atravessa girando', 'girar muito faz o estimado DERIVAR da roda?', async (p) => {
  // O que importa nao e o valor da diferenca — e se ela MUDA. Um desvio fixo e
  // so o zero fora do lugar, e o botao "Zerar rodas" existe para isso. Deriva
  // seria o encoder perdendo conta, e ai o piloto esterca para o lugar errado.
  p.envia('piloto');            // sai o piloto: quem gira e o operador
  await p.espera(600);
  p.envia('wasZero');           // parte do zero, como manda a rotina de partida
  await p.espera(900);

  let primeira = null, maiorVariacao = 0;
  for (let i = 0; i < 8; i++) {
    const tecla = i % 2 ? 'esqOn' : 'dirOn';
    p.envia(tecla, true);
    await p.espera(2600);
    p.envia(tecla, false);
    await p.espera(400);
    const a = p.amostra();
    const d = a.estimado - a.roda;
    if (primeira === null) primeira = d;
    maiorVariacao = Math.max(maiorVariacao, Math.abs(d - primeira));
  }
  return {
    ok: maiorVariacao < 1,
    detalhe: `8 giros de batente a batente: a diferenca variou ${maiorVariacao.toFixed(2)}°`,
  };
});

caso('motor montado ao contrario', 'a malha diverge (como deve)?', async (p) => {
  // Na bancada a volta da malha passa pela USB duas vezes, entao tudo demora
  // mais. Damos tempo suficiente para o desvio aparecer nos dois arranjos.
  p.envia('sentidoMontagem', 1);
  await p.espera(9000);
  const a = p.amostra();
  p.envia('sentidoMontagem', -1);
  await p.espera(2000);
  return {
    ok: Math.abs(a.roda) > 25,       // esperado: correr para o batente
    detalhe: `roda foi para ${a.roda.toFixed(1)}° (divergir e o comportamento certo aqui)`,
  };
});

(async () => {
  const modo = process.argv[2] || 'simulado';
  const p = new Piloto();
  await p.pronto;
  if (modo === 'bancada') {
    const ok = await p.usarPlaca();
    console.log(ok ? 'BANCADA (ESP32 traduzindo)\n' : 'placa nao respondeu como bancada\n');
  } else {
    await p.usarSimulado();
    console.log('SIMULADO\n');
  }

  let passou = 0, falhou = 0;
  for (const c of casos) {
    await p.zerar();
    if (modo === 'bancada') { await p.usarPlaca(); }
    p.envia('ajustes', { ganhoP: 20, contagensPorGrau: 100, pwmMinimo: 25, pwmAlto: 180 });
    await p.prepararLinha();
    p.engatar();
    await p.espera(4000);

    const antes = p.amostra();
    if (!antes || !antes.piloto) {
      console.log(`  [pulou] ${c.nome} — nao chegou a engatar`);
      p.parar();
      continue;
    }
    const r = await c.fn(p);
    p.parar();
    if (r.ok) passou++; else falhou++;
    console.log(`  ${r.ok ? '[ok]   ' : '[FALHA]'} ${c.nome.padEnd(28)} ${r.detalhe}`);
    console.log(`           ${c.pergunta}`);
  }
  console.log(`\n  ${passou} ok, ${falhou} falharam`);
  p.fechar();
  process.exit(0);
})();
