// Teste rapido da malha fechada, sem interface: o AOG pede um angulo e a gente
// olha se o conjunto firmware + motor chega la e fica.
//
// Nao substitui o teste na mao — serve para conferir que o simulador esta
// montado certo antes de alguem gastar tempo estressando ele.
//
//   node server/malha-teste.js

const { spawn } = require('child_process');
const path = require('path');
const { MotorKeya } = require('./motor.js');
const aog = require('./aog.js');

const EXE = path.join(__dirname, '..', 'sim', 'firmware_sim.exe');
const fw = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const motor = new MotorKeya();

let estado = {};
let buffer = '';
fw.stdout.on('data', (c) => {
  buffer += c.toString();
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const linha = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!linha) continue;
    let m; try { m = JSON.parse(linha); } catch { continue; }
    if (m.t === 'can_tx') motor.receberComando(m.id, m.hex);
    else if (m.t === 'state') estado = m;
  }
});

const manda = (l) => fw.stdin.write(l + '\n');
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

// Um passo de 20 ms do mundo inteiro.
async function tique(comando) {
  manda('T 20');
  motor.passo(20);
  const hb = motor.heartbeat();
  manda('C ' + hb.id + ' ' + hb.hex);
  manda('S ' + aog.steerData(comando).toString('hex').toUpperCase());
  manda('Q');
  await espera(1);
}

async function rodar(segundos, comando) {
  for (let i = 0; i < segundos * 50; i++) await tique(comando);
}

(async () => {
  await espera(300);
  manda('S ' + aog.steerSettings({ ganhoP: 40, pwmAlto: 180, pwmBaixo: 30, pwmMinimo: 25,
                                   contagensPorGrau: 19, offsetDirecao: 0, ackerman: 100 })
    .toString('hex').toUpperCase());

  const casos = [
    { nome: 'alvo +15 graus', alvo: 15, seg: 8 },
    { nome: 'alvo -10 graus', alvo: -10, seg: 8 },
    { nome: 'alvo 0 (voltar ao centro)', alvo: 0, seg: 6 },
  ];

  // O modulo precisa do zero de partida antes de qualquer coisa: piloto
  // desligado, velocidade ZERO, heartbeat fresco e PGN recente ao mesmo tempo.
  // Este roteiro comecava mandando engatar:true com velocidade 5, entao ele
  // nunca centrava e os alvos falhavam com engatado=false.
  await rodar(1, { velocidadeKmh: 0, engatar: false, anguloAlvoGraus: 0, xte: 0 });
  if (!estado.referencia || estado.travaSeguranca) {
    console.log('FALHA arranque: ref=' + estado.referencia + ' trava=' + estado.travaSeguranca
      + ' falha=' + estado.falhaNome + ' — sem isto nenhum alvo abaixo vale');
    fw.stdin.end();
    process.exit(1);
  }

  let ruins = 0;
  for (const c of casos) {
    await rodar(c.seg, { velocidadeKmh: 5, engatar: true, anguloAlvoGraus: c.alvo, xte: 0 });
    const estimado = (estado.anguloAtualX100 || 0) / 100;
    const real = motor.anguloRodasGraus;
    const erro = Math.abs(estimado - c.alvo);
    // Piloto solto NAO e "chegou no alvo". Com alvo 0 tudo comeca em zero,
    // entao o caso do centro passava mesmo com o modulo desengatado — passar
    // por acidente e o jeito de um teste parar de avisar.
    const ok = erro < 1 && estado.autosteerLigado === true;
    if (!ok) ruins++;
    console.log(
      (ok ? 'OK   ' : 'FALHA') +
      ` ${c.nome.padEnd(26)} estimado ${estimado.toFixed(2).padStart(7)}°` +
      ` · roda ${real.toFixed(2).padStart(7)}°` +
      ` · pwm ${String(estado.pwmSaida).padStart(4)}` +
      ` · engatado ${estado.autosteerLigado}`);
  }
  console.log('');
  console.log('  ' + (casos.length - ruins) + ' de ' + casos.length + ' alvos');

  fw.stdin.end();
  process.exit(ruins ? 1 : 0);
})();
