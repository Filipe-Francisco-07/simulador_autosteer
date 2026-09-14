// O que o módulo faz com a configuração do trator (PGN 251)?
//
// O simulador nunca mandou esse quadro, então nada aqui exercitava três coisas
// que os comentários do próprio firmware dizem ter custado dias de campo:
//
//   - recusar o padrão de fábrica do AgOpenGPS (set0 = 56) deixava o módulo em
//     Configuração para sempre, porque o AOG reenvia o mesmo quadro a cada
//     partida e a cada troca de perfil;
//   - ler `maxPulse` como limiar de corrente sem sensor de carga marcado dava
//     um limiar de 3 A sem ninguém pedir, e 0 derrubava a configuração toda;
//   - a velocidade mínima desengata o piloto abaixo dela.
//
// Nota de unidade: o AgOpenGPS manda a velocidade mínima em DÉCIMOS de km/h
// (`FormSteer.cs:1184` multiplica por 10), a mesma unidade do PGN 254. Mandar o
// valor cru aqui fez parecer que o firmware misturava unidades — não misturava,
// o teste é que estava errado. O construtor recebe km/h e converte.
//
// Roda direto contra o firmware, sem servidor:
//   node testes/configuracao.js

const { spawn } = require('child_process');
const path = require('path');
const { MotorKeya } = require('../server/motor.js');
const aog = require('../server/aog.js');

const EXE = path.join(__dirname, '..', 'sim', 'firmware_sim.exe');
const AJUSTES = { ganhoP: 40, pwmAlto: 180, pwmBaixo: 30, pwmMinimo: 25,
                  contagensPorGrau: 19, offsetDirecao: 0, ackerman: 100 };

class Modulo {
  constructor() {
    this.fw = spawn(EXE, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.motor = new MotorKeya();
    this.estado = {};
    let buffer = '';
    this.fw.stdout.on('data', (c) => {
      buffer += c.toString();
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const l = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        if (!l) continue;
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.t === 'can_tx') this.motor.receberComando(m.id, m.hex);
        else if (m.t === 'state') this.estado = m;
      }
    });
  }
  manda(l) { this.fw.stdin.write(l + '\n'); }
  espera(ms) { return new Promise((r) => setTimeout(r, ms)); }
  async tique(comando) {
    this.manda('T 20');
    this.motor.passo(20);
    const hb = this.motor.heartbeat();
    this.manda('C ' + hb.id + ' ' + hb.hex);
    if (comando) this.manda('S ' + aog.steerData(comando).toString('hex').toUpperCase());
    this.manda('Q');
    await this.espera(1);
  }
  async correr(n, comando) { for (let i = 0; i < n; i++) await this.tique(comando); }
  // Boot -> pronto para engatar, como o AgIO faz.
  async partir() {
    this.manda('S ' + aog.steerSettings(AJUSTES).toString('hex').toUpperCase());
    await this.correr(40, { velocidadeKmh: 0, engatar: false, anguloAlvoGraus: 0, xte: 0 });
  }
  fim() { this.fw.stdin.end(); }
}

const casos = [];
const caso = (nome, pergunta, fn) => casos.push({ nome, pergunta, fn });

caso('padrao de fabrica do AOG (set0 = 56)', 'e aceito, e o modulo segue usavel?', async (m) => {
  await m.partir();
  m.manda('S ' + aog.steerConfig({ set0: 56 }).toString('hex').toUpperCase());
  await m.correr(40, { velocidadeKmh: 0, engatar: false, anguloAlvoGraus: 0, xte: 0 });
  const f = m.estado;
  return {
    ok: f.falhaNome !== 'ajuste trocado ou recusado' && f.referencia === true,
    detalhe: `falha="${f.falhaNome}" · referencia=${f.referencia} — ` +
             'recusar o padrao do AOG travava o modulo para sempre',
  };
});

caso('InvertSteer ligado (set0 bit2)', 'e ignorado em vez de recusado?', async (m) => {
  await m.partir();
  m.manda('S ' + aog.steerConfig({ set0: 56 | 0x04 }).toString('hex').toUpperCase());
  await m.correr(40, { velocidadeKmh: 0, engatar: false, anguloAlvoGraus: 0, xte: 0 });
  const f = m.estado;
  return {
    ok: f.falhaNome !== 'ajuste trocado ou recusado',
    detalhe: `falha="${f.falhaNome}" — recusar so trocava "o sentido nao inverte" ` +
             'por "o modulo nao funciona e mostra codigo 8"',
  };
});

caso('maxPulse SEM sensor de carga', 'o limiar de corrente fica onde estava?', async (m) => {
  await m.partir();
  const antes = m.estado.limiar;
  // set1 = 0: nenhum sensor marcado, entao maxPulse e contagem de pulso
  m.manda('S ' + aog.steerConfig({ set0: 56, maxPulse: 3, set1: 0 }).toString('hex').toUpperCase());
  await m.correr(40, { velocidadeKmh: 0, engatar: false, anguloAlvoGraus: 0, xte: 0 });
  return {
    ok: m.estado.limiar === antes,
    detalhe: `limiar ${antes} -> ${m.estado.limiar} (maxPulse 3, sem sensor) — ` +
             'ler contagem de pulso como amperes dava limiar 3 sem ninguem pedir',
  };
});

caso('maxPulse COM sensor de corrente', 'o limiar passa a valer?', async (m) => {
  await m.partir();
  // set1 bit2 = sensor de corrente marcado
  m.manda('S ' + aog.steerConfig({ set0: 56, maxPulse: 12, set1: 0x04 }).toString('hex').toUpperCase());
  await m.correr(40, { velocidadeKmh: 0, engatar: false, anguloAlvoGraus: 0, xte: 0 });
  return {
    ok: m.estado.limiar === 12,
    detalhe: `limiar agora ${m.estado.limiar} (pedido 12, com sensor marcado)`,
  };
});

caso('velocidade minima', 'desengata abaixo dela?', async (m) => {
  await m.partir();
  m.manda('S ' + aog.steerConfig({ set0: 56, minSpeedKmh: 2 }).toString('hex').toUpperCase());
  await m.correr(40, { velocidadeKmh: 0, engatar: false, anguloAlvoGraus: 0, xte: 0 });
  const configurou = m.estado.velocidadeMinima === 20;   // 2 km/h em decimos

  // acima do minimo: engata
  await m.correr(60, { velocidadeKmh: 5, engatar: true, anguloAlvoGraus: 10, xte: 0 });
  const engatouRapido = m.estado.autosteerLigado === true;

  // cai abaixo do minimo
  let largou = false, motivo = null;
  for (let i = 0; i < 60 && !largou; i++) {
    await m.tique({ velocidadeKmh: 1, engatar: true, anguloAlvoGraus: 10, xte: 0 });
    if (m.estado.autosteerLigado === false) { largou = true; motivo = m.estado.falhaNome; }
  }
  return {
    ok: configurou && engatouRapido && largou && motivo === 'abaixo da velocidade minima',
    detalhe: `minSpeed=${m.estado.velocidadeMinima} · engatou a 5 km/h=${engatouRapido} · ` +
             `a 1 km/h ${largou ? 'largou por "' + motivo + '"' : 'CONTINUOU acionando'}`,
  };
});

(async () => {
  console.log('\n  CONFIGURACAO DO TRATOR (PGN 251)\n');
  let ok = 0, ruim = 0;
  for (const c of casos) {
    const m = new Modulo();
    await m.espera(300);
    let r;
    try { r = await c.fn(m); } catch (e) { r = { ok: false, detalhe: 'erro: ' + e.message }; }
    m.fim();
    r.ok ? ok++ : ruim++;
    console.log(`  [${r.ok ? ' ok ' : 'FALHA'}] ${c.nome}`);
    console.log(`          ${c.pergunta}`);
    console.log(`          ${r.detalhe}`);
  }
  console.log(`\n  ${ok} ok, ${ruim} falharam\n`);
  process.exit(ruim ? 1 : 0);
})();
