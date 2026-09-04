// Ferramenta de teste: dirige o simulador pelo WebSocket, sem navegador.
//
// O painel e otimo para explorar na mao, mas ruim para medir: cada leitura
// depende de achar um elemento na tela. Aqui a conversa e direta com o
// servidor, entao da para rodar o mesmo roteiro no simulado e na placa e
// comparar numero com numero.
//
//   node testes/piloto.js <simulado|bancada> [segundos]

const WebSocket = require('ws');

class Piloto {
  constructor(url = 'ws://localhost:3000') {
    this.ws = new WebSocket(url);
    this.estado = null;
    this.eventos = [];
    this.pronto = new Promise((r) => this.ws.on('open', r));
    this.ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.t === 'tela') this.estado = m;
      else if (m.t === 'placa' || m.t === 'espelhoFim') this.eventos.push(m);
    });
  }

  envia(acao, valor) { this.ws.send(JSON.stringify({ acao, valor })); }
  espera(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async ateTer(condicao, limiteMs = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < limiteMs) {
      if (this.estado && condicao(this.estado)) return true;
      await this.espera(100);
    }
    return false;
  }

  async usarPlaca(caminho = 'COM3') {
    this.envia('conectarPlaca', { caminho, baud: 38400 });
    await this.ateTer((e) => e.modo === 'placa', 8000);
    // o firmware de bancada se revela pelo eco do comando CAN
    await this.ateTer((e) => e.placa && e.placa.bancada, 6000);
    return this.estado && this.estado.placa && this.estado.placa.bancada;
  }

  async usarSimulado() {
    this.envia('desconectarPlaca');
    await this.ateTer((e) => e.modo === 'simulado', 6000);
  }

  async zerar() {
    this.envia('reset');
    await this.espera(1200);
  }

  // Deixa o trator andando numa marcha, cria a linha AB e sai dela de proposito.
  async prepararLinha({ marcha = 3, desvioMs = 700 } = {}) {
    for (let i = 0; i < marcha; i++) { this.envia('marcha', +1); await this.espera(120); }
    this.envia('acelerar', true);
    await this.espera(2500);
    this.envia('marcarA');
    await this.espera(3000);
    this.envia('marcarB');
    await this.espera(400);
    this.envia('dirOn', true);
    await this.espera(desvioMs);
    this.envia('dirOn', false);
    await this.espera(1200);
  }

  engatar() { this.envia('piloto'); }
  parar() { this.envia('acelerar', false); this.envia('frear', true); }

  // O que interessa medir enquanto ele guia.
  amostra() {
    const e = this.estado;
    if (!e) return null;
    const largura = e.guia.largura || 4;
    const xteBruto = e.guia.temLinha ? e.guia.xte : 0;
    return {
      xte: xteBruto - Math.round(xteBruto / largura) * largura,   // ate a passada
      roda: e.motor.anguloRodasGraus,
      estimado: (e.firmware.anguloAtualX100 || 0) / 100,
      pwm: e.firmware.pwmSaida ?? null,
      piloto: !!e.firmware.autosteerLigado || (e.guia.pilotoPedido && e.modo === 'placa'),
      velocidade: e.trator.velocidade,
      rumo: e.trator.rumo * 180 / Math.PI,
    };
  }

  fechar() { this.ws.close(); }
}

module.exports = { Piloto };

// ------------------------------------------------------------- uso direto
if (require.main === module) {
  (async () => {
    const modo = process.argv[2] || 'simulado';
    const segundos = Number(process.argv[3] || 40);
    const p = new Piloto();
    await p.pronto;
    await p.zerar();

    const atraso = Number(process.argv[4] || 0);
    if (atraso) { p.envia('atrasoMotor', atraso); console.log(`atraso artificial no motor: ${atraso} ms`); }

    if (modo === 'bancada') {
      const ok = await p.usarPlaca();
      console.log(ok ? 'placa de bancada conectada (malha fecha)\n'
                     : 'ATENCAO: a placa nao respondeu como bancada\n');
    } else {
      await p.usarSimulado();
      console.log('modo simulado\n');
    }

    await p.prepararLinha();
    p.engatar();

    console.log('  tempo   fora da passada   roda     estimado   pwm');
    const amostras = [];
    for (let i = 0; i < segundos; i++) {
      await p.espera(1000);
      const a = p.amostra();
      if (!a) continue;
      amostras.push(a);
      if (i % 5 === 0 || i === segundos - 1) {
        console.log(`  ${String(i + 1).padStart(4)}s   ${a.xte.toFixed(2).padStart(9)} m`
          + `   ${a.roda.toFixed(1).padStart(6)}°   ${a.estimado.toFixed(1).padStart(7)}°`
          + `   ${String(a.pwm).padStart(4)}`);
      }
    }
    p.parar();

    // as ultimas amostras dizem se estabilizou
    const fim = amostras.slice(-10);
    const desvios = fim.map((a) => Math.abs(a.xte));
    const pior = Math.max(...desvios);
    const media = desvios.reduce((s, v) => s + v, 0) / desvios.length;
    console.log(`\n  ultimos 10 s: erro medio ${media.toFixed(2)} m, pior ${pior.toFixed(2)} m`);
    console.log(`  ${pior < 0.3 ? 'ESTAVEL na passada' : pior < 1 ? 'oscilando um pouco' : 'NAO ESTABILIZOU'}`);
    p.fechar();
    process.exit(0);
  })();
}
