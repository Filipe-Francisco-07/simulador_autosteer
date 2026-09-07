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
  // O que importa nao e o valor da diferenca — e se ela MUDA de uma passada
  // para a outra NO MESMO LADO. Um desvio fixo e so o zero fora do lugar, e o
  // botao "Zerar rodas" existe para isso.
  //
  // A versao anterior comparava batente direito com batente esquerdo em
  // sequencia e acusava 64,8 graus de "deriva" que era so a diferenca entre os
  // dois lados — o teste falhava sem defeito nenhum embaixo. Cada lado agora e
  // comparado consigo mesmo.
  p.envia('piloto');            // sai o piloto: quem gira e o operador
  await p.espera(600);
  p.envia('wasZero');           // parte do zero, como manda a rotina de partida
  await p.espera(900);

  const porLado = { dirOn: [], esqOn: [] };
  for (let i = 0; i < 8; i++) {
    const tecla = i % 2 ? 'esqOn' : 'dirOn';
    p.envia(tecla, true);
    await p.espera(2600);
    p.envia(tecla, false);
    await p.espera(400);
    const a = p.amostra();
    porLado[tecla].push(a.estimado - a.roda);
  }
  let maiorVariacao = 0;
  const partes = [];
  for (const [lado, vs] of Object.entries(porLado)) {
    const v = Math.max(...vs) - Math.min(...vs);
    maiorVariacao = Math.max(maiorVariacao, v);
    partes.push(`${lado === 'dirOn' ? 'direita' : 'esquerda'} variou ${v.toFixed(2)}°`);
  }
  return {
    ok: maiorVariacao < 1,
    detalhe: `4 idas a cada batente: ${partes.join(' · ')}`,
  };
});

caso('motor montado ao contrario', 'alguma coisa acusa o erro fisico?', async (p) => {
  // Com o motor montado ao contrario do SENTIDO do firmware, a malha diverge:
  // o modulo acha que esta chegando no alvo enquanto a roda vai para o outro
  // lado. O que se mede aqui e a DIVERGENCIA entre o estimado e a roda — o
  // angulo absoluto depende de quanto tempo passou, e na bancada tudo e mais
  // lento por causa da USB.
  p.envia('sentidoMontagem', 1);
  await p.espera(8000);
  const a = p.amostra();
  const divergencia = Math.abs(a.estimado - a.roda);
  p.envia('sentidoMontagem', -1);
  await p.espera(2000);
  return {
    // divergir e o esperado; o que NAO existe e um aviso
    ok: divergencia > 5,
    detalhe: `firmware acha ${a.estimado.toFixed(1)}° · roda em ${a.roda.toFixed(1)}°`
      + ` · divergencia ${divergencia.toFixed(1)}° — e NADA acusa (sem WAS nao ha como saber)`,
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
