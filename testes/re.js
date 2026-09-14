// A re com o piloto engatado — o chamado 7.
//
// O AgOpenGPS decide se esta de re comparando o rumo do GPS com o rumo real.
// Sao duas chaves diferentes, e confundi-las e facil:
//   Reverse On       (Config > Dados)  = o AOG DETECTA a re
//   Steer In Reverse (tela de direcao) = o piloto CONTINUA estercando de re
//
// Com a deteccao desligada, o rumo trava apontando para frente e o piloto
// esterca para o lado errado. E o sintoma relatado em campo.
//
//   node testes/re.js <simulado|bancada>
const { Piloto } = require('./piloto.js');

async function cenario(p, { reverseOn, steerInReverse }) {
  await p.zerar();
  if (p.naPlaca) await p.usarPlaca();
  p.envia('ajustes', { ganhoP: 20, contagensPorGrau: 19, pwmMinimo: 25, pwmAlto: 180 });
  p.envia('reverseOn', reverseOn);
  p.envia('steerInReverse', steerInReverse);
  await p.espera(400);

  await p.prepararLinha({ desvioMs: 500 });
  p.engatar();
  // Na bancada a volta da malha passa pela USB, entao tudo demora mais.
  // Espera ate acionar de verdade em vez de contar um tempo fixo.
  await p.ateTer((e) => !!e.firmware.autosteerLigado, 8000);
  await p.espera(1500);
  const indoFrente = p.amostra();

  // para, engata a re e anda para tras
  p.envia('acelerar', false);
  p.envia('frear', true);
  await p.espera(2500);
  p.envia('frear', false);
  for (let i = 0; i < 4; i++) { p.envia('marcha', -1); await p.espera(150); }
  p.envia('acelerar', true);
  await p.espera(5000);

  const deRe = p.amostra();
  const e = p.estado;
  p.parar();
  await p.espera(1200);

  return {
    frenteOk: indoFrente.piloto,
    velocidade: deRe.velocidade,
    aogDetectou: !!e.guia.aogEmRe,
    pilotoDeRe: deRe.piloto,
    rumoInvertido: deRe.velocidade < -0.1 && !e.guia.aogEmRe,
  };
}

(async () => {
  const modo = process.argv[2] || 'simulado';
  const p = new Piloto();
  await p.pronto;
  p.naPlaca = modo === 'bancada';
  if (p.naPlaca) {
    const ok = await p.usarPlaca();
    console.log(ok ? 'BANCADA — ESP32 traduzindo\n' : 'placa nao respondeu como bancada\n');
  } else {
    await p.usarSimulado();
    console.log('SIMULADO\n');
  }

  const casos = [
    { nome: 'detecta re, nao esterca (o padrao)', reverseOn: true,  steerInReverse: false },
    { nome: 'detecta re E esterca de re',          reverseOn: true,  steerInReverse: true  },
    { nome: 'NAO detecta re (o chamado 7)',        reverseOn: false, steerInReverse: false },
  ];

  for (const c of casos) {
    const r = await cenario(p, c);
    console.log(`  ${c.nome}`);
    console.log(`     indo para frente: piloto ${r.frenteOk ? 'engatado' : 'NAO ENGATOU'}`);
    console.log(`     de re a ${r.velocidade.toFixed(1)} km/h: o AOG ${r.aogDetectou ? 'DETECTOU' : 'nao detectou'}`
      + ` · piloto ${r.pilotoDeRe ? 'ACIONANDO' : 'solto'}`);
    if (r.rumoInvertido) {
      console.log(`     >> RUMO INVERTIDO: o AOG acha que vai para frente enquanto anda para tras`);
      console.log(`        e o piloto ${r.pilotoDeRe ? 'CONTINUA acionando — esterca para o lado errado' : 'esta solto (o risco nao se concretiza)'}`);
    }
    console.log('');
  }
  p.fechar();
  process.exit(0);
})();
