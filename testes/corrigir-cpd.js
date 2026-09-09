// Prova ponta a ponta: o modulo comeca com o CPD errado, o GPS descobre, o
// operador manda aplicar, e o angulo na tela passa a bater com a roda.
//
// E o cenario do teste de campo de 30/08 reproduzido de proposito: alguem
// digita 100 na tela do AgOpenGPS, a maquina responde 19, e nada avisa. Aqui a
// unica coisa que sabe a verdade e o GPS.
//
//   node testes/corrigir-cpd.js

const { Piloto } = require('./piloto.js');

// Passeio em escada: vira um pouco, SEGURA, vira mais. Ziguezague continuo
// borra o angulo dentro da janela de medida do arco.
async function escada(p, ciclos = 2) {
  const degraus = [
    ['dirOn', 1200], [null, 4000], ['dirOn', 900], [null, 4000],
    ['esqOn', 1400], [null, 4000], ['esqOn', 900], [null, 4000],
    ['esqOn', 1200], [null, 4000], ['dirOn', 1400], [null, 4000],
  ];
  for (let c = 0; c < ciclos; c++) {
    for (const [tecla, ms] of degraus) {
      if (tecla) { p.envia(tecla, true); await p.espera(ms); p.envia(tecla, false); }
      else await p.espera(ms);
    }
  }
}

function erroDeEscala(a) {
  // Quanto o estimado esta fora do real, em proporcao. Perto de 1 e bom.
  if (Math.abs(a.roda) < 3) return null;
  return a.estimado / a.roda;
}

(async () => {
  const p = new Piloto();
  await p.pronto;
  // 'reset' e o nome da acao no servidor. Isto dizia 'reiniciar', que nao
  // existe no switch e caia fora sem erro nenhum: o teste NUNCA reiniciava e
  // herdava o que a sessao anterior tivesse deixado no motor (velocidade,
  // folga, escorregamento). Passou meses parecendo certo porque so rodava logo
  // depois de subir o servidor, quando os padroes ja estavam no lugar.
  await p.zerar();
  // parametros do motor explicitos: este teste e sobre CPD, e herdar velocidade
  // ou folga de outro roteiro faz a medida do GPS dizer qualquer coisa.
  p.envia('velMotor', 4);
  p.envia('folga', 0);
  p.envia('escorregamento', 0);
  p.envia('atrasoMotor', 0);
  await p.espera(800);

  // 1. o mundo: a maquina tem 19 contagens por grau (o que o Pedro mediu).
  p.envia('cpdReal', 19);
  // 2. a tela: alguem digitou 100, como no AgOpenGPS de fabrica.
  p.envia('ajustes', { contagensPorGrau: 100, offsetDirecao: 0 });
  await p.espera(800);

  // piloto desligado: quem gira o volante e o operador
  if (p.estado.firmware.statusPedido) { p.envia('piloto'); await p.espera(400); }
  p.envia('acelerar', true);
  p.envia('marcha', 1);
  await p.espera(3000);

  console.log('\n  CORRIGIR O CPD PELO GPS\n');
  console.log('  maquina de verdade: 19 contagens/grau');
  console.log('  configurado na tela: ' + p.estado.aog.ajustes.contagensPorGrau + '\n');

  await escada(p, 2);

  const antes = p.amostra();
  const escalaAntes = erroDeEscala(antes);
  console.log(`  ANTES  roda ${antes.roda.toFixed(1)}°  ·  o modulo acha ${antes.estimado.toFixed(1)}°` +
              (escalaAntes ? `  ·  escala ${escalaAntes.toFixed(2)}x` : ''));

  const cal = p.estado.calibragem;
  if (!cal || !cal.pronto) {
    console.log('\n  o calibrador nao juntou material suficiente: ' + (cal && cal.motivo));
    process.exit(1);
  }
  for (const l of cal.laudo) console.log('    ' + l);

  // 3. o operador manda aplicar
  const resposta = new Promise((r) => {
    p.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'calibragem') r(m);
    });
  });
  p.envia('aplicarCalibragem');
  const res = await Promise.race([resposta, p.espera(4000).then(() => null)]);
  console.log('\n  aplicar: ' + JSON.stringify(res && res.ok ? res.agora : res));

  // 4. mais um passeio para o modulo reler a roda com o ajuste novo
  await escada(p, 1);
  const depois = p.amostra();
  const escalaDepois = erroDeEscala(depois);
  console.log(`\n  DEPOIS roda ${depois.roda.toFixed(1)}°  ·  o modulo acha ${depois.estimado.toFixed(1)}°` +
              (escalaDepois ? `  ·  escala ${escalaDepois.toFixed(2)}x` : ''));

  const cpdFinal = p.estado.firmware.contagensPorGrau;
  const ok = res && res.ok && Math.abs(cpdFinal - 19) <= 3;
  console.log(`\n  CPD no firmware: ${cpdFinal} (verdade 19)`);
  console.log(`  ${ok ? 'ok' : 'FALHOU'}\n`);
  process.exit(ok ? 0 : 1);
})();
