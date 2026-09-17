// Conversa com o modulo tradutor: le a configuracao vigente e grava a nova.
//
// Fala com DUAS pontas possiveis, com a mesma interface:
//   - porta serial de verdade (o ESP32 no monitor);
//   - o firmware rodando no PC (sim/firmware_sim.exe), para desenvolver sem placa.
//
// POR QUE A PORTA SERIAL, E NAO O AgIO
// O AgIO abre e SEGURA a porta do tradutor (`spSteerModule`), e porta serial no
// Windows e exclusiva: dois programas nao abrem a mesma. Alem disso o AgIO
// roteia por numero de PGN e a tabela dele (UDP.designer.cs) nao inclui o 240,
// que e o do nosso protocolo de servico — entao nem passando por ele daria.
//
// Isso define o lugar desta ferramenta no produto: ela roda ANTES do AgIO,
// enquanto a porta esta livre. Ver README.md.

const { SerialPort } = require('serialport');
const { spawn } = require('child_process');
const path = require('path');
const aog = require('../server/aog.js');

const BAUD = 38400;                 // o firmware fixa isso
const ESPERA_RESPOSTA_MS = 1500;

// Separa quadros PGN de um fluxo de bytes que tambem carrega texto (o banner
// do firmware sai pela mesma porta). Reaproveita a logica do modo placa.
class Fatiador {
  constructor(aoQuadro) {
    this.aoQuadro = aoQuadro;
    this.buf = Buffer.alloc(0);
  }
  receber(pedaco) {
    this.buf = Buffer.concat([this.buf, pedaco]);
    let i = 0;
    while (i + 5 <= this.buf.length) {
      if (this.buf[i] !== 0x80 || this.buf[i + 1] !== 0x81) { i++; continue; }
      const total = this.buf[i + 4] + 6;
      if (i + total > this.buf.length) break;      // quadro incompleto
      this.aoQuadro(this.buf.subarray(i, i + total));
      i += total;
    }
    this.buf = this.buf.subarray(i);
    if (this.buf.length > 4096) this.buf = this.buf.subarray(this.buf.length - 512);
  }
}

class Tradutor {
  constructor() {
    this.porta = null;
    this.processo = null;
    this.fatiador = new Fatiador((q) => this._quadro(q));
    this.esperando = new Map();     // marca -> resolve
    this.proximaMarca = 1;
    this.ultimoDiagnostico = null;
    this.texto = [];
  }

  // ---- ligacao ----

  async abrirPorta(caminho) {
    await this.fechar();
    await new Promise((ok, erro) => {
      this.porta = new SerialPort({ path: caminho, baudRate: BAUD, autoOpen: false });
      this.porta.on('data', (d) => this.fatiador.receber(d));
      this.porta.on('error', () => {});
      this.porta.open((e) => (e ? erro(e) : ok()));
    });
    this.origem = 'porta ' + caminho;
  }

  // Firmware real compilado para PC. Serve para desenvolver e para demonstrar
  // sem o ESP32 na mesa — e o MESMO codigo que vai gravado na placa.
  async abrirSimulado() {
    await this.fechar();
    const exe = path.join(__dirname, '..', 'sim', 'firmware_sim.exe');
    this.processo = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    let linha = '';
    this.processo.stdout.on('data', (c) => {
      linha += c.toString();
      let i;
      while ((i = linha.indexOf('\n')) >= 0) {
        const l = linha.slice(0, i).trim(); linha = linha.slice(i + 1);
        if (!l) continue;
        let m; try { m = JSON.parse(l); } catch { continue; }
        if (m.t === 'serial_tx') this.fatiador.receber(Buffer.from(m.hex, 'hex'));
      }
    });
    // o firmware simulado so anda quando mandam o relogio andar
    this.relogio = setInterval(() => {
      if (!this.processo) return;
      this.processo.stdin.write('T 20\n');
      // heartbeat do motor, senao o modulo se considera sem CAN
      this.processo.stdin.write('C 117440513 0000000000000001\n');
    }, 20);
    this.origem = 'firmware no PC';
    await new Promise((r) => setTimeout(r, 400));
  }

  async fechar() {
    if (this.relogio) { clearInterval(this.relogio); this.relogio = null; }
    if (this.processo) { this.processo.stdin.end(); this.processo = null; }
    if (this.porta && this.porta.isOpen) {
      await new Promise((r) => this.porta.close(() => r()));
    }
    this.porta = null;
    this.origem = null;
  }

  get ligado() { return !!(this.porta && this.porta.isOpen) || !!this.processo; }

  _enviar(quadro) {
    if (this.porta && this.porta.isOpen) this.porta.write(quadro);
    else if (this.processo) {
      this.processo.stdin.write('S ' + quadro.toString('hex').toUpperCase() + '\n');
    }
  }

  _quadro(q) {
    const d = aog.parseDiagnostico(q);
    if (!d) return;
    if (!d.crcOk) return;
    if (d.etiqueta === 'AP01') this.ultimoDiagnostico = d;
    const resolver = this.esperando.get(d.marca);
    if (resolver) { this.esperando.delete(d.marca); resolver(d); }
  }

  // ---- protocolo ----

  // Manda uma pergunta de servico e espera a resposta com a MESMA marca.
  // A marca existe para nao casar a resposta errada quando ha mais de uma
  // pergunta no ar — o firmware devolve o byte que recebeu.
  _servico(op, extras = {}) {
    const marca = (this.proximaMarca = (this.proximaMarca % 250) + 1);
    const quadro = aog.servico(op, { ...extras, marca });
    return new Promise((resolve, reject) => {
      const relogio = setTimeout(() => {
        this.esperando.delete(marca);
        reject(new Error('o modulo nao respondeu em ' + ESPERA_RESPOSTA_MS + ' ms'));
      }, ESPERA_RESPOSTA_MS);
      this.esperando.set(marca, (d) => { clearTimeout(relogio); resolve(d); });
      this._enviar(quadro);
    });
  }

  ler() { return this._servico(aog.OPS_SERVICO.LER); }

  // ---- escrita ----
  //
  // Cada grupo vai pelo quadro que o firmware entende:
  //   PGN 252 — CPD, Ackerman, ganho, PWM, offset
  //   PGN 251 — corrente de desligamento, velocidade minima, bits de config
  //   servico op2 — esterçamento maximo (o envelope do modulo)

  async gravar(perfil) {
    const passos = [];

    this._enviar(aog.steerSettings({
      ganhoP: perfil.ganhoP,
      pwmAlto: perfil.pwmAlto,
      pwmBaixo: perfil.pwmBaixo,
      pwmMinimo: perfil.pwmMinimo,
      contagensPorGrau: perfil.contagensPorGrau,
      offsetDirecao: perfil.offsetDirecao,
      ackerman: perfil.ackerman,
    }));
    passos.push('ajustes (PGN 252)');
    await this._respirar();

    // O limiar de corrente so e aceito com sensor de carga marcado — sem isso o
    // firmware trata maxPulse como contagem de pulso e ignora. Ver o comentario
    // em main.cpp: sensorDeCarga = (set1 & 0x06).
    this._enviar(aog.steerConfig({
      set0: perfil.set0,
      maxPulse: perfil.correnteDesligamento,
      minSpeedKmh: perfil.velocidadeMinimaKmh,
      set1: perfil.set1 | 0x04,
    }));
    passos.push('configuracao (PGN 251)');
    await this._respirar();

    const r = await this._servico(aog.OPS_SERVICO.LIMITES, {
      limiteEsquerdo: Math.round(perfil.estercoMaxEsquerdaGraus * 100),
      limiteDireito: Math.round(perfil.estercoMaxDireitaGraus * 100),
    });
    passos.push('esterçamento maximo (servico op2) -> ' +
                (r.resultado === 0 ? 'aceito' : 'RECUSADO'));

    await this._respirar();
    const conferencia = await this.ler();
    return { passos, conferencia, recusouLimites: r.resultado !== 0 };
  }

  _respirar() { return new Promise((r) => setTimeout(r, 250)); }
}

// Confere o que o modulo diz contra o que o perfil pede. Devolve so as
// diferencas: gravar e facil, o dificil e ter certeza de que pegou.
function conferir(perfil, lido) {
  const dif = [];
  const cmp = (nome, pedido, obtido) => {
    if (pedido !== obtido) dif.push({ nome, pedido, obtido });
  };
  cmp('CPD', perfil.contagensPorGrau, lido.contagensPorGrau);
  cmp('Ackerman', perfil.ackerman, lido.ackerman);
  cmp('corrente de desligamento', perfil.correnteDesligamento, lido.limiar);
  cmp('esterçamento max esquerda', Math.round(perfil.estercoMaxEsquerdaGraus * 100), lido.limiteEsquerdo);
  cmp('esterçamento max direita', Math.round(perfil.estercoMaxDireitaGraus * 100), lido.limiteDireito);
  return dif;
}

module.exports = { Tradutor, conferir, BAUD };
