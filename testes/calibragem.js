// Prova que da para medir o esterçamento pelo GPS, sem sensor nas rodas.
//
// O metodo so vale se ele acertar quando a resposta e conhecida. Aqui o mundo e
// montado com valores ESCOLHIDOS (CPD, sentido de montagem, centro deslocado,
// escorregamento do orbitrol), o trator anda em ziguezague e o calibrador tem
// que devolver os mesmos numeros olhando so para GPS e encoder.
//
// O ruido de GPS entra de proposito: sem ele a conta seria uma inversao exata
// do modelo e nao provaria nada sobre o campo. O que entra ruidoso e a POSICAO
// (RTK fixed, 2 cm), que e o dado bruto de verdade — derivar rumo dela e parte
// do problema, nao um atalho permitido.
//
// O passeio e uma ESCADA, nao um ziguezague: o operador vira um pouco, SEGURA
// alguns segundos, vira mais, segura. Cada degrau vira uma medida de curvatura
// limpa. Ziguezague continuo borra o angulo dentro da janela de medida e foi o
// que fez a primeira versao deste teste nao fechar.
//
//   node testes/calibragem.js

const { MotorKeya } = require('../server/motor.js');
const { Trator } = require('../server/trator.js');
const { CalibradorPorGps } = require('../server/calibrador.js');

const PASSO_MS = 20;
// O firmware chama encoderAtualizar(..., sentido = -1, ...): ele soma o delta do
// encoder invertido. Uma montagem que casa com isso e a montagem CERTA.
const SENTIDO_DO_FIRMWARE = -1;
const HZ_GPS = 10;                 // o AOG recebe posicao a 10 Hz
const RUIDO_POSICAO_M = 0.02;      // RTK fixed: 2 cm

function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Um passeio em escada: degraus de angulo mantidos por alguns segundos.
function passear({ cpdReal, sentidoMontagem, centroInicial, escorregamento,
                   velocidadeKmh = 6, comRuido = true,
                   degraus = [0, 5, 10, 15, 10, 5, 0, -5, -10, -15, -10, -5],
                   segundosPorDegrau = 6, voltas = 2 }) {
  const motor = new MotorKeya();
  motor.contagensPorGrauReal = cpdReal;
  motor.sentidoMontagem = sentidoMontagem;
  motor.escorregamento = escorregamento;
  motor.batenteGraus = 40;
  motor.posicaoMotor = centroInicial;

  const trator = new Trator();
  trator.velocidade = velocidadeKmh;
  // velocidadeMaxima e um getter que le a marcha; para segurar a velocidade
  // exata do teste eu sombreio o getter e deixo o trator "acelerando" contra
  // esse teto. Assim ele nao perde velocidade sozinho e a medida nao fica com
  // um vies de desaceleracao que eu depois leria como erro do metodo.
  Object.defineProperty(trator, 'velocidadeMaxima', { value: velocidadeKmh });
  trator.acelerando = true;

  const cal = new CalibradorPorGps({ entreEixos: trator.entreEixos });

  const total = degraus.length * segundosPorDegrau * voltas * 1000;
  let t = 0, proximoGps = 0;

  while (t < total) {
    const i = Math.floor(t / 1000 / segundosPorDegrau) % degraus.length;
    const alvo = degraus[i];
    const erro = alvo - motor.anguloRodasGraus;
    motor.girarManual(Math.max(-0.5, Math.min(0.5, erro)));

    trator.anguloRodas = motor.anguloRodasGraus;
    trator.passo(PASSO_MS);
    t += PASSO_MS;

    if (t >= proximoGps) {
      proximoGps += 1000 / HZ_GPS;
      // O calibrador recebe POSICAO com ruido de RTK, que e o dado cru que o
      // AOG tem. Ele que se vire para tirar curvatura disso.
      cal.observarPosicao({
        t,
        x: trator.x + (comRuido ? gauss() * RUIDO_POSICAO_M : 0),
        y: trator.y + (comRuido ? gauss() * RUIDO_POSICAO_M : 0),
        velocidadeKmh: trator.velocidade,
        // O que o MODULO acumula, nao o cru do motor: o firmware aplica
        // SENTIDO -1 ao delta do encoder antes de somar. Alimentar o cru fazia
        // o calibrador chamar de "invertida" a montagem correta.
        contagens: SENTIDO_DO_FIRMWARE * motor.posicaoMotor,
      });
    }
  }
  return { cal, motor, trator };
}

// ------------------------------------------------------------------ casos

const casos = [];
const caso = (nome, fn) => casos.push({ nome, fn });

function perto(a, b, tol) { return Math.abs(a - b) <= tol; }

caso('acha o CPD que o Pedro mediu no JD 5078 (19 contagens por grau)', () => {
  const { cal } = passear({ cpdReal: 19, sentidoMontagem: -1, centroInicial: 0, escorregamento: 0 });
  const r = cal.resultado();
  if (!r.pronto) return { ok: false, detalhe: r.motivo };
  return {
    ok: perto(r.cpd, 19, 19 * 0.10) && !r.invertido,
    detalhe: `mediu ${r.cpd.toFixed(1)} (verdade 19) · R2=${r.r2.toFixed(3)} · ${r.n} amostras`,
  };
});

caso('acha o CPD 100 que estava configurado errado', () => {
  const { cal } = passear({ cpdReal: 100, sentidoMontagem: -1, centroInicial: 0, escorregamento: 0 });
  const r = cal.resultado();
  if (!r.pronto) return { ok: false, detalhe: r.motivo };
  return {
    ok: perto(r.cpd, 100, 10),
    detalhe: `mediu ${r.cpd.toFixed(1)} (verdade 100) · R2=${r.r2.toFixed(3)}`,
  };
});

caso('DENUNCIA motor montado ao contrario', () => {
  const { cal } = passear({ cpdReal: 19, sentidoMontagem: +1, centroInicial: 0, escorregamento: 0 });
  const r = cal.resultado();
  if (!r.pronto) return { ok: false, detalhe: r.motivo };
  return {
    ok: r.invertido === true && perto(r.cpd, 19, 19 * 0.10),
    detalhe: `invertido=${r.invertido} · |CPD|=${r.cpd.toFixed(1)} · ` +
             'e a falha que hoje passa calada ate o trator fugir da linha',
  };
});

caso('acha o centro quando o zero de partida pegou as rodas tortas', () => {
  // 4 graus de roda para a direita no momento do boot, com CPD 19 = 76 contagens
  // no encoder cru. No referencial do MODULO isso troca de sinal, porque e ele
  // quem o calibrador enxerga.
  const desvioCru = 76;
  const desvio = SENTIDO_DO_FIRMWARE * desvioCru;
  const { cal } = passear({ cpdReal: 19, sentidoMontagem: -1, centroInicial: desvioCru, escorregamento: 0 });
  const r = cal.resultado();
  if (!r.pronto) return { ok: false, detalhe: r.motivo };
  const grausDeErro = (desvio - r.centro) / r.cpd;
  return {
    ok: perto(r.centro, desvio, 25),
    detalhe: `centro medido ${r.centro.toFixed(0)}, verdade ${desvio} ` +
             `(erro de ${grausDeErro.toFixed(2)} grau)`,
  };
});

caso('mede o escorregamento do orbitrol', () => {
  // 8% de perda: o motor gira mais do que a roda anda, e o zero foge.
  const { cal } = passear({ cpdReal: 19, sentidoMontagem: -1, centroInicial: 0,
                            escorregamento: 0.08, voltas: 3 });
  const r = cal.resultado();
  if (!r.pronto) return { ok: false, detalhe: r.motivo };
  return {
    ok: r.derivaPorMinuto != null,
    detalhe: `deriva ${r.derivaPorMinuto == null ? 'n/d' : r.derivaPorMinuto.toFixed(1)} ` +
             `contagens/min · CPD ${r.cpd.toFixed(1)} · R2=${r.r2.toFixed(3)}`,
  };
});

caso('SE RECUSA a responder andando reto (sem curva nao ha o que medir)', () => {
  const { cal } = passear({ cpdReal: 19, sentidoMontagem: -1, centroInicial: 0,
                            escorregamento: 0, degraus: [0, 0.2, 0, -0.2] });
  const r = cal.resultado();
  // Tem que recusar PELO MOTIVO CERTO: recusar por falta de amostra seria o
  // teste passando por acidente, e um teste que passa por acidente e pior que
  // um que falha — ele para de avisar quando o defeito aparece.
  return {
    // Duas recusas honestas servem: "faltou curva" (o angulo nao variou) e
    // "o encoder quase nao saiu do lugar" (o volante nao variou). Andando reto
    // as duas sao verdade; o que NAO pode e responder um numero.
    ok: r.pronto === false && /faltou curva|encoder quase nao saiu/.test(r.motivo || ''),
    detalhe: r.pronto ? `RESPONDEU MESMO ASSIM: CPD ${r.cpd.toFixed(1)} — numero inventado`
                      : `recusou: ${r.motivo} (${r.n || 0} amostras colhidas)`,
  };
});

caso('SE RECUSA a responder com o trator parado', () => {
  const { cal } = passear({ cpdReal: 19, sentidoMontagem: -1, centroInicial: 0,
                            escorregamento: 0, velocidadeKmh: 0.4 });
  const r = cal.resultado();
  return {
    ok: r.pronto === false && /poucas amostras/.test(r.motivo || ''),
    detalhe: r.pronto ? 'RESPONDEU PARADO — a conta divide por velocidade ~0'
                      : `recusou: ${r.motivo} (${r.n || 0} amostras colhidas)`,
  };
});

caso('funciona a 3 km/h, que e a velocidade de plantio', () => {
  const { cal } = passear({ cpdReal: 19, sentidoMontagem: -1, centroInicial: 0,
                            escorregamento: 0, velocidadeKmh: 3, voltas: 3 });
  const r = cal.resultado();
  if (!r.pronto) return { ok: false, detalhe: r.motivo };
  return {
    ok: perto(r.cpd, 19, 19 * 0.15),
    detalhe: `mediu ${r.cpd.toFixed(1)} (verdade 19) · R2=${r.r2.toFixed(3)} — ` +
             'devagar o ruido de rumo pesa mais',
  };
});

caso('sem ruido de GPS o erro fica abaixo de 2%', () => {
  const { cal } = passear({ cpdReal: 19, sentidoMontagem: -1, centroInicial: 0,
                            escorregamento: 0, comRuido: false });
  const r = cal.resultado();
  if (!r.pronto) return { ok: false, detalhe: r.motivo };
  const erro = Math.abs(r.cpd - 19) / 19;
  return {
    ok: erro < 0.02,
    detalhe: `erro de ${(erro * 100).toFixed(2)}% · R2=${r.r2.toFixed(4)} — ` +
             'isto isola o metodo do ruido: o que sobra e limite da conta, nao do GPS',
  };
});

// ------------------------------------------------------------------ execucao

(async () => {
  console.log('\n  CALIBRAGEM DO ESTERÇAMENTO PELO GPS\n');
  let ok = 0, ruim = 0;
  for (const c of casos) {
    let r;
    try { r = await c.fn(); } catch (e) { r = { ok: false, detalhe: 'erro: ' + e.message }; }
    console.log(`  [${r.ok ? ' ok ' : 'FALHA'}] ${c.nome}`);
    console.log(`          ${r.detalhe}`);
    r.ok ? ok++ : ruim++;
  }
  console.log(`\n  ${ok} ok, ${ruim} falharam\n`);
  process.exit(ruim ? 1 : 0);
})();
