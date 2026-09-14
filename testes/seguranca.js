// Os cenarios que assustam: o que acontece quando algo da errado com o piloto
// engatado e o trator andando.
//
// Cada um responde a uma pergunta que alguem faria antes de subir no trator.
const { Piloto } = require('./piloto.js');

const casos = [];
const caso = (nome, pergunta, fn) => casos.push({ nome, pergunta, fn });

caso('mao no volante (override)', 'o modulo larga e CONTINUA solto?', async (p) => {
  // Override e o operador PEGAR o volante e VIRAR contra o piloto engatado.
  //
  // Ate 08/09 este caso so ligava a bandeira `maoNoVolante` e esperava. Isso
  // nunca foi um override: o simulador proibia girar o volante com o piloto
  // ligado, e a mao sozinha nao freava o motor — so trocava a leitura de
  // corrente. O caso passava porque a planta antiga (CPD 100) era lenta e
  // deixava o PWM alto o tempo todo, entao a corrente ficava alta por tabela.
  // Com a calibragem certa o modulo chega na linha, o PWM vai a zero, e a mao
  // parada deixou de encontrar qualquer coisa — o caso quebrou e mostrou que
  // media outra coisa.
  p.envia('maoNoVolante', true);
  p.envia('dirOn', true);
  await p.espera(2500);
  const durante = p.amostra();
  const falhaDurante = p.estado.firmware.falhaNome;
  p.envia('dirOn', false);
  p.envia('maoNoVolante', false);
  await p.espera(3000);
  const depois = p.amostra();
  return {
    ok: !durante.piloto && !depois.piloto,
    detalhe: `virando contra: ${durante.piloto ? 'AINDA ACIONA' : 'largou (' + falhaDurante + ')'}`
      + ` · 3 s depois de soltar: ${depois.piloto ? 'VOLTOU A ACIONAR' : 'continua solto'}`,
  };
});

caso('mao apoiada, sem virar', 'quanto tempo ate a mao parada derrubar o piloto?', async (p) => {
  // O complemento do override. A primeira versao deste caso afirmava que a mao
  // apoiada NAO deveria desengatar, e falhava metade das vezes — porque a
  // resposta depende de quando o modulo faz a proxima correcao, e isso e sorte,
  // nao comportamento. Teste que depende de sorte nao avisa nada.
  //
  // O que da para afirmar e outra coisa, e ela importa no trator: com o piloto
  // ligado o modulo corrige de tempos em tempos, e na primeira correcao a mao
  // apoiada vira carga. Ou seja apoiar a mao no volante DERRUBA o piloto — e o
  // operador precisa saber disso, senao vai achar que o sistema falhou sozinho.
  //
  // O que este caso exige e que, SE cair, caia pelo motivo certo.
  p.envia('maoNoVolante', true);
  const t0 = Date.now();
  let quandoCaiu = null, motivo = null;
  for (let i = 0; i < 30 && quandoCaiu === null; i++) {
    await p.espera(200);
    if (!p.amostra().piloto) {
      quandoCaiu = Date.now() - t0;
      motivo = p.estado.firmware.falhaNome;
    }
  }
  p.envia('maoNoVolante', false);
  return {
    // Continuar engatado tambem e resposta valida: quer dizer que nao houve
    // correcao nenhuma na janela. O que NAO pode e cair por outro motivo.
    ok: quandoCaiu === null || motivo === 'sobrecorrente',
    detalhe: quandoCaiu === null
      ? 'seguiu engatado por 6 s (nao houve correcao nesse tempo)'
      : `caiu em ${(quandoCaiu / 1000).toFixed(1)} s por ${motivo}`
        + ' — apoiar a mao derruba o piloto na primeira correcao',
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
    // CPD 19, nao 100: e o que o batente medido no JD 5078 implica. Ficou 100
    // aqui quando o resto do simulador ja tinha sido corrigido, e com o modulo
    // subestimando o angulo 5,3x os cenarios que dependem do angulo (batente,
    // sentido invertido) mediam outra coisa que nao o que dizem medir.
    p.envia('ajustes', { ganhoP: 20, contagensPorGrau: 19, pwmMinimo: 25, pwmAlto: 180 });
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
